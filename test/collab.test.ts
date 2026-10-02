import { randomUUID } from 'crypto';
import { createServer, Server as HttpServer } from 'http';
import { AddressInfo } from 'net';
import { io as connect, Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app, ORIGIN, resetData, setupDb } from './helpers';
import { closePool, query } from '../src/db';
import { attachCollab } from '../src/collab/socket';
import { flushRoom } from '../src/collab/rooms';

let server: HttpServer;
let url: string;
const sockets: Socket[] = [];

beforeAll(async () => {
  await setupDb();
  server = createServer(app);
  attachCollab(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  url = `http://localhost:${(server.address() as AddressInfo).port}`;
});
beforeEach(resetData);
afterEach(() => {
  sockets.splice(0).forEach((s) => s.disconnect());
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await closePool();
});

/** A signed-up user's session cookie. */
async function account(email: string) {
  const res = await request(app)
    .post('/auth/register')
    .set('Origin', ORIGIN)
    .send({ email, password: 'correct horse', name: email.split('@')[0] });
  expect(res.status).toBe(201);
  const cookie = (res.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
  const call = (method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, body?: object) =>
    request(app)[method](path).set('Origin', ORIGIN).set('Cookie', cookie).send(body);
  return { cookie, id: res.body.user.id as string, call };
}

type Account = Awaited<ReturnType<typeof account>>;

async function diagram(owner: Account) {
  const diagramId = randomUUID();
  const res = await owner.call('post', '/diagrams', {
    diagramId,
    name: 'Shop',
    database: 'postgresql',
    tables: [{ id: 't1', name: 'users', fields: [] }],
  });
  expect(res.status).toBe(201);
  return diagramId;
}

/** A connected client that records what it receives. */
async function client(cookie?: string) {
  const socket = connect(url, {
    path: '/socket.io',
    transports: ['websocket'],
    extraHeaders: { Origin: ORIGIN, ...(cookie && { Cookie: cookie }) },
    forceNew: true,
  });
  sockets.push(socket);
  const received: Record<string, unknown[]> = {};
  socket.onAny((event, payload) => (received[event] ??= []).push(payload));
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
  const emit = <T = Record<string, unknown>>(event: string, payload: object) =>
    socket.timeout(3000).emitWithAck(event, payload) as Promise<T>;
  /** Resolves once an event arrives (or has arrived). */
  const next = async (event: string, count = 1) => {
    for (let i = 0; i < 100 && (received[event]?.length ?? 0) < count; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    return received[event]?.[count - 1] as Record<string, unknown>;
  };
  return { socket, received, emit, next };
}

const setName = (name: string) => [{ t: 'set', p: ['name'], v: name }];

describe('joining', () => {
  it('gives editors the live state and keeps out others', async () => {
    const ada = await account('ada@example.com');
    const bob = await account('bob@example.com');
    const id = await diagram(ada);

    const a = await client(ada.cookie);
    const joined = await a.emit('join', { diagramId: id, clientId: 'a' });
    expect(joined).toMatchObject({
      seq: 0,
      role: 'owner',
      canWrite: true,
      state: { name: 'Shop', database: 'postgresql', tables: [{ id: 't1' }] },
      self: { userId: ada.id, name: 'ada' },
      peers: [],
    });

    const b = await client(bob.cookie);
    expect(await b.emit('join', { diagramId: id, clientId: 'b' })).toEqual({
      error: 'diagram_not_found',
    });
    const anon = await client();
    expect(await anon.emit('join', { diagramId: id, clientId: 'x' })).toEqual({
      error: 'diagram_not_found',
    });
  });

  it('rejects connections from other sites', async () => {
    const socket = connect(url, {
      path: '/socket.io',
      transports: ['websocket'],
      extraHeaders: { Origin: 'https://evil.example' },
      forceNew: true,
    });
    sockets.push(socket);
    const error = await new Promise<Error>((resolve) => socket.once('connect_error', resolve));
    expect(error.message).toBe('bad_origin');
  });
});

describe('editing together', () => {
  it('orders edits, sends them to everyone and saves them', async () => {
    const ada = await account('ada@example.com');
    const bob = await account('bob@example.com');
    const id = await diagram(ada);
    await ada.call('post', `/diagrams/${id}/members`, { email: 'bob@example.com', role: 'editor' });

    const a = await client(ada.cookie);
    const b = await client(bob.cookie);
    await a.emit('join', { diagramId: id, clientId: 'a' });
    const bJoin = await b.emit('join', { diagramId: id, clientId: 'b' });
    expect(bJoin.peers).toMatchObject([{ userId: ada.id }]);
    expect(await a.next('peer-join')).toMatchObject({ userId: bob.id });

    expect(await a.emit('ops', { diagramId: id, opId: 'a1', ops: setName('Store') })).toEqual({
      seq: 1,
    });
    await b.emit('ops', {
      diagramId: id,
      opId: 'b1',
      ops: [{ t: 'set', p: ['tables', { i: 't1' }, 'name'], v: 'customers' }],
    });

    // Both see both, in the same order, with who sent them
    for (const c of [a, b]) {
      await c.next('ops', 2);
      expect(c.received.ops.map((m) => (m as { seq: number; clientId: string }).clientId)).toEqual([
        'a',
        'b',
      ]);
    }

    await flushRoom(id);
    const [row] = await query<{
      name: string;
      content: { tables: { name: string }[] };
      updated_by: string;
    }>('SELECT name, content, updated_by FROM diagrams WHERE id = $1', [id]);
    expect(row).toMatchObject({
      name: 'Store',
      content: { tables: [{ name: 'customers' }] },
      updated_by: bob.id,
    });
    expect(await a.next('saved')).toMatchObject({ version: 2 });

    // Someone joining later starts from the live state
    const late = await client(ada.cookie);
    expect(await late.emit('join', { diagramId: id, clientId: 'a2' })).toMatchObject({
      seq: 2,
      state: { name: 'Store' },
    });
  });

  it('tells a returning client which of its edits arrived', async () => {
    const ada = await account('ada@example.com');
    const id = await diagram(ada);
    const a = await client(ada.cookie);
    await a.emit('join', { diagramId: id, clientId: 'tab-1' });
    await a.emit('ops', { diagramId: id, opId: 'op-7', ops: setName('x') });

    const again = await client(ada.cookie);
    expect(await again.emit('join', { diagramId: id, clientId: 'tab-1' })).toMatchObject({
      lastOp: 'op-7',
    });
  });

  it('relays cursors without storing them', async () => {
    const ada = await account('ada@example.com');
    const id = await diagram(ada);
    const a = await client(ada.cookie);
    const a2 = await client(ada.cookie);
    await a.emit('join', { diagramId: id, clientId: 'a' });
    await a2.emit('join', { diagramId: id, clientId: 'a2' });
    a.socket.emit('awareness', {
      cursor: { x: 10, y: 20 },
      selection: { element: 1, id: 't1' },
      linking: { startX: 1, startY: 2, endX: 3, endY: 4, extra: 'x' },
      extra: 'x',
    });
    expect(await a2.next('awareness')).toEqual({
      sid: a.socket.id,
      cursor: { x: 10, y: 20 },
      selection: { element: 1, id: 't1' },
      linking: { startX: 1, startY: 2, endX: 3, endY: 4 },
    });
    a.socket.emit('awareness', { cursor: null, linking: { startX: 1, startY: 'x' } });
    expect(await a2.next('awareness', 2)).toEqual({
      sid: a.socket.id,
      cursor: null,
      selection: null,
      linking: null,
    });
  });

  it('rejects bad operations', async () => {
    const ada = await account('ada@example.com');
    const id = await diagram(ada);
    const a = await client(ada.cookie);
    await a.emit('join', { diagramId: id, clientId: 'a' });
    expect(
      await a.emit('ops', {
        diagramId: id,
        opId: '1',
        ops: [{ t: 'set', p: ['owner_id'], v: 'x' }],
      }),
    ).toEqual({ error: 'invalid_input' });
    expect(await a.emit('ops', { diagramId: randomUUID(), opId: '1', ops: [] })).toEqual({
      error: 'not_joined',
    });
  });
});

describe('access', () => {
  it('lets viewers and view links watch but not edit', async () => {
    const ada = await account('ada@example.com');
    const cy = await account('cy@example.com');
    const id = await diagram(ada);
    await ada.call('post', `/diagrams/${id}/members`, { email: 'cy@example.com', role: 'viewer' });
    const links = await ada.call('put', `/diagrams/${id}/links/viewer`, {});
    const token = links.body.links[0].token;

    const viewer = await client(cy.cookie);
    expect(await viewer.emit('join', { diagramId: id, clientId: 'c' })).toMatchObject({
      role: 'viewer',
      canWrite: false,
    });
    expect(await viewer.emit('ops', { diagramId: id, opId: '1', ops: setName('x') })).toEqual({
      error: 'read_only',
    });

    const guest = await client();
    expect(await guest.emit('join', { diagramId: id, clientId: 'g', link: token })).toMatchObject({
      role: 'viewer',
      self: { userId: null },
    });
    const a = await client(ada.cookie);
    await a.emit('join', { diagramId: id, clientId: 'a' });
    await a.emit('ops', { diagramId: id, opId: '1', ops: setName('Live') });
    expect(await guest.next('ops')).toMatchObject({ ops: setName('Live') });
  });

  it('applies role changes and removals right away', async () => {
    const ada = await account('ada@example.com');
    const bob = await account('bob@example.com');
    const id = await diagram(ada);
    await ada.call('post', `/diagrams/${id}/members`, { email: 'bob@example.com', role: 'editor' });
    const b = await client(bob.cookie);
    await b.emit('join', { diagramId: id, clientId: 'b' });

    await ada.call('patch', `/diagrams/${id}/members/${bob.id}`, { role: 'viewer' });
    expect(await b.next('role')).toEqual({ role: 'viewer', canWrite: false });
    expect(await b.emit('ops', { diagramId: id, opId: '1', ops: setName('x') })).toEqual({
      error: 'read_only',
    });

    await ada.call('delete', `/diagrams/${id}/members/${bob.id}`);
    expect(await b.next('kicked')).toEqual({ diagramId: id });
    expect(await b.emit('ops', { diagramId: id, opId: '2', ops: setName('x') })).toEqual({
      error: 'not_joined',
    });
  });

  it('closes the room when the diagram goes to the trash or its link is turned off', async () => {
    const ada = await account('ada@example.com');
    const id = await diagram(ada);
    const links = await ada.call('put', `/diagrams/${id}/links/viewer`, {});
    const guest = await client();
    await guest.emit('join', { diagramId: id, clientId: 'g', link: links.body.links[0].token });
    const a = await client(ada.cookie);
    await a.emit('join', { diagramId: id, clientId: 'a' });

    await ada.call('delete', `/diagrams/${id}/links/viewer`);
    expect(await guest.next('kicked')).toEqual({ diagramId: id });
    expect(a.received.kicked).toBeUndefined();

    await ada.call('delete', `/diagrams/${id}`);
    expect(await a.next('kicked')).toEqual({ diagramId: id });
  });
});

describe('changes from outside the room', () => {
  it('sends everyone the new state after a save or a restore', async () => {
    const ada = await account('ada@example.com');
    const id = await diagram(ada);
    const a = await client(ada.cookie);
    await a.emit('join', { diagramId: id, clientId: 'a' });
    await a.emit('ops', { diagramId: id, opId: '1', ops: setName('Live edit') });

    // A save from an editor without a live connection, based on the
    // version that includes the live edit
    const current = await ada.call('get', `/diagrams/${id}`);
    expect(current.body.diagram.name).toBe('Shop'); // not saved yet...
    const saved = await ada.call('put', `/diagrams/${id}`, {
      name: 'From REST',
      tables: [],
      baseVersion: 2, // ...but the save flushes it first (version 2)
    });
    expect(saved.status).toBe(200);
    expect(await a.next('reset')).toMatchObject({ state: { name: 'From REST', tables: [] } });

    const { body } = await ada.call('get', `/diagrams/${id}/versions`);
    const restored = await ada.call(
      'post',
      `/diagrams/${id}/versions/${body.versions[body.versions.length - 1].id}/restore`,
    );
    expect(restored.status).toBe(200);
    expect(await a.next('reset', 2)).toMatchObject({ state: { name: 'Shop' } });
  });
});

describe('teams', () => {
  it('disconnects people removed from a team the diagram is shared with', async () => {
    const ada = await account('ada@example.com');
    const bob = await account('bob@example.com');
    const id = await diagram(ada);
    const team = await ada.call('post', '/teams', { name: 'Backend' });
    const teamId = team.body.team.id;
    await ada.call('post', `/teams/${teamId}/members`, { email: 'bob@example.com', role: 'member' });
    await ada.call('post', `/diagrams/${id}/teams`, { teamId, role: 'editor' });

    const b = await client(bob.cookie);
    expect(await b.emit('join', { diagramId: id, clientId: 'b' })).toMatchObject({ role: 'editor' });
    await ada.call('patch', `/diagrams/${id}/teams/${teamId}`, { role: 'viewer' });
    expect(await b.next('role')).toEqual({ role: 'viewer', canWrite: false });

    await ada.call('delete', `/teams/${teamId}/members/${bob.id}`);
    expect(await b.next('kicked')).toEqual({ diagramId: id });
  });
});
