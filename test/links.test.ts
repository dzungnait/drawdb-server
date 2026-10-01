import { randomUUID } from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { browser, ORIGIN, resetData, setupDb, signUp } from './helpers';
import { closePool, query } from '../src/db';

beforeAll(setupDb);
beforeEach(resetData);
afterAll(closePool);

type Browser = ReturnType<typeof browser>;

async function create(b: Browser) {
  const diagramId = randomUUID();
  const res = await b.post('/diagrams', {
    diagramId,
    name: 'Shop',
    tables: [{ id: 't', name: 'users' }],
  });
  expect(res.status).toBe(201);
  return diagramId;
}

async function link(
  owner: Browser,
  id: string,
  role: 'viewer' | 'editor',
  expiresAt?: string | null,
) {
  const res = await owner.agent
    .put(`/diagrams/${id}/links/${role}`)
    .set('Origin', ORIGIN)
    .send({ expiresAt });
  expect(res.status).toBe(200);
  return res.body.links.find((l: { role: string }) => l.role === role).token as string;
}

const open = (b: Browser, id: string, token?: string) => {
  const r = b.agent.get(`/diagrams/${id}`);
  return token ? r.set('X-Share-Link', token) : r;
};

const save = (b: Browser, id: string, token: string, baseVersion: number) =>
  b.agent
    .put(`/diagrams/${id}`)
    .set('Origin', ORIGIN)
    .set('X-Share-Link', token)
    .send({ name: 'Shop', tables: [], baseVersion });

describe('view links', () => {
  it('let anyone view, even signed out', async () => {
    const { b: ada } = await signUp('ada@example.com');
    const id = await create(ada);
    const token = await link(ada, id, 'viewer');

    const anon = browser();
    expect((await open(anon, id)).status).toBe(404);
    const res = await open(anon, id, token);
    expect(res.status).toBe(200);
    expect(res.body.diagram).toMatchObject({
      role: 'viewer',
      canWrite: false,
      access: 'link',
      tables: [{ name: 'users' }],
    });

    // Viewing doesn't allow saving, or anything else
    const { b: bob } = await signUp('bob@example.com');
    expect((await open(bob, id, token)).body.diagram.role).toBe('viewer');
    expect((await save(bob, id, token, 1)).status).toBe(403);
    expect((await bob.agent.get(`/diagrams/${id}/members`).set('X-Share-Link', token)).status).toBe(
      403,
    );
  });

  it("only work for their own diagram and don't show up in lists", async () => {
    const { b: ada } = await signUp('ada@example.com');
    const id = await create(ada);
    const other = await create(ada);
    const token = await link(ada, id, 'viewer');

    const res = await open(browser(), other, token);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('link_invalid');

    const { b: bob } = await signUp('bob@example.com');
    await open(bob, id, token);
    expect((await bob.get('/diagrams')).body.diagrams).toEqual([]);
  });
});

describe('edit links', () => {
  it('let signed-in people edit and view-only for the signed out', async () => {
    const { b: ada } = await signUp('ada@example.com');
    const id = await create(ada);
    const token = await link(ada, id, 'editor');

    const anon = await open(browser(), id, token);
    expect(anon.body.diagram).toMatchObject({
      role: 'viewer',
      canWrite: false,
      signInToEdit: true,
    });
    expect((await save(browser(), id, token, 1)).status).toBe(401);

    const { b: bob } = await signUp('bob@example.com');
    expect((await open(bob, id, token)).body.diagram).toMatchObject({
      role: 'editor',
      canWrite: true,
      signInToEdit: false,
    });
    expect((await save(bob, id, token, 1)).status).toBe(200);
    // Editors through a link use the history too
    expect(
      (await bob.agent.get(`/diagrams/${id}/versions`).set('X-Share-Link', token)).status,
    ).toBe(200);
    // ...but can't manage the diagram
    expect(
      (await bob.agent.delete(`/diagrams/${id}`).set('Origin', ORIGIN).set('X-Share-Link', token))
        .status,
    ).toBe(403);
  });

  it("don't lower anyone's access", async () => {
    const { b: ada } = await signUp('ada@example.com');
    const { b: bob } = await signUp('bob@example.com');
    const id = await create(ada);
    await ada.post(`/diagrams/${id}/members`, { email: 'bob@example.com', role: 'editor' });
    const token = await link(ada, id, 'viewer');
    expect((await open(bob, id, token)).body.diagram).toMatchObject({
      role: 'editor',
      access: 'member',
    });
    expect((await open(ada, id, token)).body.diagram.role).toBe('owner');
  });
});

describe('managing links', () => {
  it('regenerates, expires and turns links off', async () => {
    const { b: ada } = await signUp('ada@example.com');
    const id = await create(ada);
    const first = await link(ada, id, 'viewer');

    // Changing the expiry keeps the link
    const later = new Date(Date.now() + 86_400_000).toISOString();
    expect(await link(ada, id, 'viewer', later)).toBe(first);

    const regenerated = await ada.post(`/diagrams/${id}/links/viewer/regenerate`);
    const second = regenerated.body.links[0].token;
    expect(second).not.toBe(first);
    expect((await open(browser(), id, first)).status).toBe(404);
    expect((await open(browser(), id, second)).status).toBe(200);

    await query(`UPDATE share_links SET expires_at = now() - interval '1 minute'`);
    expect((await open(browser(), id, second)).status).toBe(404);
    expect((await ada.get(`/diagrams/${id}/links`)).body.links[0]).toMatchObject({ expired: true });

    await link(ada, id, 'viewer', null);
    expect((await open(browser(), id, second)).status).toBe(200);
    const off = await ada.delete(`/diagrams/${id}/links/viewer`);
    expect(off.body.links).toEqual([]);
    expect((await open(browser(), id, second)).status).toBe(404);
  });

  it('is up to the owner', async () => {
    const { b: ada } = await signUp('ada@example.com');
    const { b: bob } = await signUp('bob@example.com');
    const id = await create(ada);
    await ada.post(`/diagrams/${id}/members`, { email: 'bob@example.com', role: 'editor' });

    expect((await bob.get(`/diagrams/${id}/links`)).status).toBe(403);
    const res = await bob.agent.put(`/diagrams/${id}/links/viewer`).set('Origin', ORIGIN).send({});
    expect(res.status).toBe(403);
    expect((await ada.post(`/diagrams/${id}/links/viewer/regenerate`)).status).toBe(404);
    const past = await ada.agent
      .put(`/diagrams/${id}/links/viewer`)
      .set('Origin', ORIGIN)
      .send({ expiresAt: '2000-01-01T00:00:00Z' });
    expect(past.status).toBe(400);
  });

  it('stops working while the diagram is in the trash', async () => {
    const { b: ada } = await signUp('ada@example.com');
    const id = await create(ada);
    const token = await link(ada, id, 'viewer');
    await ada.delete(`/diagrams/${id}`);
    expect((await open(browser(), id, token)).status).toBe(404);
  });
});
