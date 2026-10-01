import { randomUUID } from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { browser, resetData, setupDb, signUp } from './helpers';
import { closePool, query } from '../src/db';

beforeAll(setupDb);
beforeEach(resetData);
afterAll(closePool);

const sample = (overrides: Record<string, unknown> = {}) => ({
  name: 'Shop',
  database: 'mysql',
  tables: [{ id: 't1', name: 'users', fields: [] }],
  references: [],
  notes: [],
  areas: [],
  views: [],
  pan: { x: 10, y: 20 },
  zoom: 1.5,
  ...overrides,
});

async function create(b: ReturnType<typeof browser>, overrides: Record<string, unknown> = {}) {
  const diagramId = randomUUID();
  const res = await b.post('/diagrams', { diagramId, ...sample(overrides) });
  expect(res.status).toBe(201);
  return { diagramId, version: res.body.diagram.version as number };
}

describe('access', () => {
  it('requires a session', async () => {
    const res = await browser().get('/diagrams');
    expect(res.status).toBe(401);
  });

  it("hides other users' diagrams as if they don't exist", async () => {
    const { b: ada } = await signUp('ada@example.com');
    const { b: bob } = await signUp('bob@example.com');
    const { diagramId } = await create(ada);

    expect((await bob.get(`/diagrams/${diagramId}`)).status).toBe(404);
    expect((await bob.post(`/diagrams/${diagramId}/restore`)).status).toBe(404);
    const put = await bob.agent.put(`/diagrams/${diagramId}`).set('Origin', 'http://app.test').send(sample());
    expect(put.status).toBe(404);
    expect((await bob.delete(`/diagrams/${diagramId}`)).status).toBe(404);
    expect((await bob.get('/diagrams')).body.diagrams).toEqual([]);
  });
});

describe('create, load, list', () => {
  it('round-trips the editor state', async () => {
    const { b, user } = await signUp();
    const { diagramId, version } = await create(b);
    expect(version).toBe(1);

    const res = await b.get(`/diagrams/${diagramId}`);
    expect(res.status).toBe(200);
    expect(res.body.diagram).toMatchObject({
      diagramId,
      name: 'Shop',
      database: 'mysql',
      tables: [{ id: 't1', name: 'users', fields: [] }],
      pan: { x: 10, y: 20 },
      zoom: 1.5,
      version: 1,
      role: 'owner',
      canWrite: true,
      owner: { id: user.id, email: 'ada@example.com', username: 'Ada' },
    });
  });

  it('drops unknown keys instead of storing them', async () => {
    const { b } = await signUp();
    const { diagramId } = await create(b, { evil: 'x'.repeat(100), lastModified: 'whatever' });
    const [row] = await query<{ content: Record<string, unknown> }>('SELECT content FROM diagrams WHERE id = $1', [
      diagramId,
    ]);
    expect(row.content.evil).toBeUndefined();
    expect(row.content.lastModified).toBeUndefined();
  });

  it('rejects a duplicate id and malformed input', async () => {
    const { b } = await signUp();
    const { diagramId } = await create(b);
    expect((await b.post('/diagrams', { diagramId, ...sample() })).status).toBe(409);
    expect((await b.post('/diagrams', { diagramId: 'not-a-uuid', ...sample() })).status).toBe(400);
    expect((await b.post('/diagrams', { diagramId: randomUUID(), ...sample({ tables: 'nope' }) })).status).toBe(400);
  });

  it('lists own diagrams newest first with size and owner', async () => {
    const { b } = await signUp();
    const first = await create(b, { name: 'First' });
    const second = await create(b, { name: 'Second' });
    const res = await b.get('/diagrams');
    expect(res.body.diagrams.map((d: { name: string }) => d.name)).toEqual(['Second', 'First']);
    expect(res.body.diagrams[0]).toMatchObject({ diagramId: second.diagramId, database: 'mysql', version: 1 });
    expect(res.body.diagrams[0].sizeBytes).toBeGreaterThan(50);
    expect(res.body.diagrams[0].tables).toBeUndefined();
    expect(first).toBeTruthy();
  });
});

describe('saving with versions', () => {
  it('saves on top of the latest version and bumps it', async () => {
    const { b } = await signUp();
    const { diagramId } = await create(b);
    const res = await b.agent
      .put(`/diagrams/${diagramId}`)
      .set('Origin', 'http://app.test')
      .send({ ...sample({ name: 'Renamed' }), baseVersion: 1 });
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(2);
    expect((await b.get(`/diagrams/${diagramId}`)).body.diagram).toMatchObject({ name: 'Renamed', version: 2 });
  });

  it('reports a conflict when saving on top of an old version', async () => {
    const { b } = await signUp();
    const { diagramId } = await create(b);
    const put = (body: object) => b.agent.put(`/diagrams/${diagramId}`).set('Origin', 'http://app.test').send(body);

    // Two tabs both start from version 1
    expect((await put({ ...sample({ name: 'Tab A' }), baseVersion: 1 })).status).toBe(200);
    const stale = await put({ ...sample({ name: 'Tab B' }), baseVersion: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('version_conflict');
    expect(stale.body.error.details.version).toBe(2);
    expect((await b.get(`/diagrams/${diagramId}`)).body.diagram.name).toBe('Tab A');

    // Overwriting on purpose
    const forced = await put({ ...sample({ name: 'Tab B' }), baseVersion: 1, force: true });
    expect(forced.status).toBe(200);
    expect(forced.body.version).toBe(3);
    expect((await b.get(`/diagrams/${diagramId}`)).body.diagram.name).toBe('Tab B');
  });

  it('treats a save without a base version as a conflict', async () => {
    const { b } = await signUp();
    const { diagramId } = await create(b);
    const res = await b.agent.put(`/diagrams/${diagramId}`).set('Origin', 'http://app.test').send(sample());
    expect(res.status).toBe(409);
  });
});

describe('trash', () => {
  it('moves to the trash, restores, and only deletes forever from the trash', async () => {
    const { b } = await signUp();
    const { diagramId } = await create(b);

    expect((await b.delete(`/diagrams/${diagramId}/permanent`)).status).toBe(409);
    expect((await b.delete(`/diagrams/${diagramId}`)).status).toBe(204);
    expect((await b.get(`/diagrams/${diagramId}`)).status).toBe(404);
    expect((await b.get('/diagrams')).body.diagrams).toEqual([]);
    expect((await b.get('/diagrams/trash')).body.diagrams.map((d: { diagramId: string }) => d.diagramId)).toEqual([
      diagramId,
    ]);

    const restored = await b.post(`/diagrams/${diagramId}/restore`);
    expect(restored.status).toBe(200);
    expect((await b.get(`/diagrams/${diagramId}`)).status).toBe(200);

    await b.delete(`/diagrams/${diagramId}`);
    expect((await b.delete(`/diagrams/${diagramId}/permanent`)).status).toBe(204);
    expect(await query('SELECT 1 FROM diagrams')).toHaveLength(0);
  });

  it('cannot save into a trashed diagram', async () => {
    const { b } = await signUp();
    const { diagramId } = await create(b);
    await b.delete(`/diagrams/${diagramId}`);
    const res = await b.agent
      .put(`/diagrams/${diagramId}`)
      .set('Origin', 'http://app.test')
      .send({ ...sample(), baseVersion: 1 });
    expect(res.status).toBe(404);
  });

  it('purges diagrams that stayed in the trash too long', async () => {
    const { purgeTrash } = await import('../src/services/diagram-service');
    const { b } = await signUp();
    const old = await create(b);
    const recent = await create(b);
    await b.delete(`/diagrams/${old.diagramId}`);
    await b.delete(`/diagrams/${recent.diagramId}`);
    await query(`UPDATE diagrams SET deleted_at = now() - interval '31 days' WHERE id = $1`, [old.diagramId]);
    await purgeTrash();
    const left = await query<{ id: string }>('SELECT id FROM diagrams');
    expect(left.map((r) => r.id)).toEqual([recent.diagramId]);
  });
});

describe('account deletion', () => {
  it("removes the user's diagrams", async () => {
    const { b } = await signUp();
    await create(b);
    await b.delete('/auth/me', { password: 'correct horse' });
    expect(await query('SELECT 1 FROM diagrams')).toHaveLength(0);
  });
});
