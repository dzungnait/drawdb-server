import { randomUUID } from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { browser, ORIGIN, resetData, setupDb, signUp } from './helpers';
import { closePool, query } from '../src/db';
import { config } from '../src/config';
import { testOutbox } from '../src/utils/send-email';

beforeAll(setupDb);
beforeEach(async () => {
  await resetData();
  testOutbox.length = 0;
});
afterAll(closePool);

type Browser = ReturnType<typeof browser>;

async function create(b: Browser, name = 'Shop') {
  const diagramId = randomUUID();
  const res = await b.post('/diagrams', { diagramId, name, tables: [] });
  expect(res.status).toBe(201);
  return diagramId;
}

const put = (b: Browser, id: string, baseVersion: number) =>
  b.agent
    .put(`/diagrams/${id}`)
    .set('Origin', ORIGIN)
    .send({ name: 'Shop', tables: [], baseVersion });

/** Owner Ada, editor Bob and viewer Cy on one diagram. */
async function team() {
  const ada = await signUp('ada@example.com', 'correct horse', 'Ada');
  const bob = await signUp('bob@example.com', 'correct horse', 'Bob');
  const cy = await signUp('cy@example.com', 'correct horse', 'Cy');
  const id = await create(ada.b);
  expect(
    (await ada.b.post(`/diagrams/${id}/members`, { email: 'Bob@Example.com', role: 'editor' })).body
      .status,
  ).toBe('added');
  await ada.b.post(`/diagrams/${id}/members`, { email: 'cy@example.com', role: 'viewer' });
  return { ada, bob, cy, id };
}

describe('roles', () => {
  it('lets editors edit and viewers only look', async () => {
    const { bob, cy, id } = await team();

    const asEditor = await bob.b.get(`/diagrams/${id}`);
    expect(asEditor.body.diagram).toMatchObject({
      role: 'editor',
      canWrite: true,
      owner: { username: 'Ada' },
    });
    expect((await put(bob.b, id, 1)).status).toBe(200);
    expect((await bob.b.get(`/diagrams/${id}/versions`)).status).toBe(200);

    const asViewer = await cy.b.get(`/diagrams/${id}`);
    expect(asViewer.body.diagram).toMatchObject({ role: 'viewer', canWrite: false });
    expect((await put(cy.b, id, 2)).status).toBe(403);
    expect((await cy.b.get(`/diagrams/${id}/versions`)).status).toBe(403);
  });

  it('keeps managing the diagram to the owner', async () => {
    const { bob, cy, id } = await team();
    for (const b of [bob.b, cy.b]) {
      expect(
        (await b.post(`/diagrams/${id}/members`, { email: 'x@example.com', role: 'viewer' }))
          .status,
      ).toBe(403);
      expect(
        (await b.patch(`/diagrams/${id}/members/${cy.user.id}`, { role: 'editor' })).status,
      ).toBe(403);
      expect((await b.delete(`/diagrams/${id}`)).status).toBe(403);
    }
    // Editors may not remove others either
    expect((await bob.b.delete(`/diagrams/${id}/members/${cy.user.id}`)).status).toBe(403);
    const { body } = await bob.b.post(`/diagrams/${id}/versions`, { label: 'x' });
    expect((await bob.b.delete(`/diagrams/${id}/versions/${body.version.id}`)).status).toBe(403);
  });

  it('shows who has access, with invitations only to the owner', async () => {
    const { ada, bob, id } = await team();
    await ada.b.post(`/diagrams/${id}/members`, { email: 'new@example.com', role: 'viewer' });

    const asOwner = (await ada.b.get(`/diagrams/${id}/members`)).body;
    expect(asOwner.owner).toMatchObject({ name: 'Ada', email: 'ada@example.com' });
    expect(asOwner.members.map((m: { name: string; role: string }) => [m.name, m.role])).toEqual([
      ['Bob', 'editor'],
      ['Cy', 'viewer'],
    ]);
    expect(asOwner.invites).toMatchObject([{ email: 'new@example.com', role: 'viewer' }]);

    const asEditor = (await bob.b.get(`/diagrams/${id}/members`)).body;
    expect(asEditor).toMatchObject({ role: 'editor', invites: [] });
    expect(asEditor.members).toHaveLength(2);
  });
});

describe('listing', () => {
  it('lists own and shared diagrams, filtered by scope', async () => {
    const { ada, bob, id } = await team();
    const own = await create(bob.b, 'Bob own');
    await create(ada.b, 'Not shared');

    const all = (await bob.b.get('/diagrams')).body.diagrams;
    expect(
      all.map((d: { diagramId: string; role: string }) => [d.diagramId, d.role]).sort(),
    ).toEqual(
      [
        [id, 'editor'],
        [own, 'owner'],
      ].sort(),
    );
    expect(all.find((d: { diagramId: string }) => d.diagramId === id)).toMatchObject({
      owner: { username: 'Ada' },
    });

    const owned = (await bob.b.get('/diagrams?scope=owned')).body.diagrams;
    expect(owned.map((d: { diagramId: string }) => d.diagramId)).toEqual([own]);
    const shared = (await bob.b.get('/diagrams?scope=shared')).body.diagrams;
    expect(shared.map((d: { diagramId: string }) => d.diagramId)).toEqual([id]);

    const adas = (await ada.b.get('/diagrams?scope=owned')).body.diagrams;
    expect(adas.find((d: { diagramId: string }) => d.diagramId === id).sharedWith).toBe(2);
  });

  it("hides shared diagrams that are in the owner's trash", async () => {
    const { ada, bob, id } = await team();
    await ada.b.delete(`/diagrams/${id}`);
    expect((await bob.b.get('/diagrams')).body.diagrams).toEqual([]);
    expect((await bob.b.get('/diagrams/trash')).body.diagrams).toEqual([]);
    expect((await bob.b.get(`/diagrams/${id}`)).status).toBe(404);
  });
});

describe('changing access', () => {
  it('changes roles and removes people', async () => {
    const { ada, cy, id } = await team();
    await ada.b.patch(`/diagrams/${id}/members/${cy.user.id}`, { role: 'editor' });
    expect((await cy.b.get(`/diagrams/${id}`)).body.diagram.canWrite).toBe(true);

    // Sharing again with the same person also just changes the role
    await ada.b.post(`/diagrams/${id}/members`, { email: 'cy@example.com', role: 'viewer' });
    expect((await cy.b.get(`/diagrams/${id}`)).body.diagram.canWrite).toBe(false);
    expect(
      testOutbox.filter((m) => m.to === 'cy@example.com' && m.subject.includes('shared')),
    ).toHaveLength(1);

    expect((await ada.b.delete(`/diagrams/${id}/members/${cy.user.id}`)).status).toBe(204);
    expect((await cy.b.get(`/diagrams/${id}`)).status).toBe(404);
  });

  it('lets members leave', async () => {
    const { bob, id } = await team();
    expect((await bob.b.delete(`/diagrams/${id}/members/${bob.user.id}`)).status).toBe(204);
    expect((await bob.b.get(`/diagrams/${id}`)).status).toBe(404);
  });

  it("doesn't share with the owner or strangers to the diagram", async () => {
    const { ada, id } = await team();
    expect(
      (await ada.b.post(`/diagrams/${id}/members`, { email: 'ADA@example.com', role: 'editor' }))
        .status,
    ).toBe(400);
    expect(
      (await ada.b.post(`/diagrams/${id}/members`, { email: 'not-an-email', role: 'editor' }))
        .status,
    ).toBe(400);
    expect(
      (await ada.b.post(`/diagrams/${id}/members`, { email: 'z@example.com', role: 'owner' }))
        .status,
    ).toBe(400);

    const { b: eve } = await signUp('eve@example.com');
    expect((await eve.get(`/diagrams/${id}/members`)).status).toBe(404);
    expect(
      (await eve.post(`/diagrams/${id}/members`, { email: 'eve2@example.com', role: 'editor' }))
        .status,
    ).toBe(404);
  });

  it('ends access when the account is deleted', async () => {
    const { bob, id } = await team();
    await query('DELETE FROM users WHERE id = $1', [bob.user.id]);
    expect(
      await query('SELECT 1 FROM diagram_members WHERE diagram_id = $1 AND user_id = $2', [
        id,
        bob.user.id,
      ]),
    ).toEqual([]);
  });
});

describe('invitations', () => {
  it('emails the invitee, who gets access after signing up', async () => {
    const { b: ada } = await signUp('ada@example.com', 'correct horse', 'Ada');
    const id = await create(ada, 'Billing');
    const res = await ada.post(`/diagrams/${id}/members`, {
      email: 'Dan@Example.com',
      role: 'editor',
    });
    expect(res.body).toMatchObject({ status: 'invited', invites: [{ email: 'dan@example.com' }] });
    const mail = testOutbox.find((m) => m.to === 'dan@example.com')!;
    expect(mail.subject).toContain('Billing');
    expect(mail.html).toContain(`/editor/diagrams/${id}`);

    // This server sends no mail outside tests, so the email is taken on trust
    const { b: dan } = await signUp('dan@example.com');
    expect((await dan.get(`/diagrams/${id}`)).body.diagram.role).toBe('editor');
    expect((await ada.get(`/diagrams/${id}/members`)).body.invites).toEqual([]);
  });

  it('waits for a verified email when the server can send mail', async () => {
    const { b: ada } = await signUp('ada@example.com');
    const id = await create(ada);
    await ada.post(`/diagrams/${id}/members`, { email: 'dan@example.com', role: 'viewer' });

    const mail = { ...config.mail };
    Object.assign(config.mail, { username: 'u', password: 'p' });
    try {
      const { b: dan, user } = await signUp('dan@example.com');
      expect((await dan.get(`/diagrams/${id}`)).status).toBe(404);
      await query('UPDATE users SET email_verified_at = now() WHERE id = $1', [user.id]);
      expect((await dan.get(`/diagrams/${id}`)).body.diagram.role).toBe('viewer');
    } finally {
      Object.assign(config.mail, mail);
    }
  });

  it('can be cancelled', async () => {
    const { b: ada } = await signUp('ada@example.com');
    const id = await create(ada);
    const { body } = await ada.post(`/diagrams/${id}/members`, {
      email: 'dan@example.com',
      role: 'viewer',
    });
    const cancelled = await ada.delete(`/diagrams/${id}/invites/${body.invites[0].id}`);
    expect(cancelled.body.invites).toEqual([]);

    const { b: dan } = await signUp('dan@example.com');
    expect((await dan.get(`/diagrams/${id}`)).status).toBe(404);
  });
});
