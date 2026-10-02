import { randomUUID } from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { browser, ORIGIN, resetData, setupDb, signUp } from './helpers';
import { closePool } from '../src/db';

beforeAll(setupDb);
beforeEach(resetData);
afterAll(closePool);

type Browser = ReturnType<typeof browser>;

async function createTeam(b: Browser, name = 'Backend') {
  const res = await b.post('/teams', { name });
  expect(res.status).toBe(201);
  return res.body.team.id as string;
}

async function createDiagram(b: Browser) {
  const diagramId = randomUUID();
  expect((await b.post('/diagrams', { diagramId, name: 'Shop', tables: [] })).status).toBe(201);
  return diagramId;
}

const put = (b: Browser, id: string, baseVersion: number) =>
  b.agent
    .put(`/diagrams/${id}`)
    .set('Origin', ORIGIN)
    .send({ name: 'Shop', tables: [], baseVersion });

describe('teams', () => {
  it('are created with the creator as admin and listed for members only', async () => {
    const { b: ada, user } = await signUp('ada@example.com', 'correct horse', 'Ada');
    const { b: bob } = await signUp('bob@example.com');
    const id = await createTeam(ada);

    expect((await ada.get('/teams')).body.teams).toMatchObject([
      { id, name: 'Backend', role: 'admin', memberCount: 1 },
    ]);
    const team = (await ada.get(`/teams/${id}`)).body.team;
    expect(team.members).toMatchObject([{ id: user.id, name: 'Ada', role: 'admin' }]);

    expect((await bob.get('/teams')).body.teams).toEqual([]);
    expect((await bob.get(`/teams/${id}`)).status).toBe(404);
  });

  it('adds people by email, inviting those without an account', async () => {
    const { b: ada } = await signUp('ada@example.com');
    const { b: bob } = await signUp('bob@example.com');
    const id = await createTeam(ada);

    const added = await ada.post(`/teams/${id}/members`, {
      email: 'Bob@Example.com',
      role: 'member',
    });
    expect(added.body).toMatchObject({ status: 'added', memberCount: 2 });
    expect(
      (await ada.post(`/teams/${id}/members`, { email: 'bob@example.com', role: 'member' })).status,
    ).toBe(409);
    const invited = await ada.post(`/teams/${id}/members`, {
      email: 'dan@example.com',
      role: 'admin',
    });
    expect(invited.body).toMatchObject({
      status: 'invited',
      invites: [{ email: 'dan@example.com' }],
    });

    // Members see the team, not the invitations
    expect((await bob.get(`/teams/${id}`)).body.team).toMatchObject({
      role: 'member',
      invites: [],
    });
    expect(
      (await bob.post(`/teams/${id}/members`, { email: 'x@example.com', role: 'member' })).status,
    ).toBe(403);

    const { b: dan } = await signUp('dan@example.com');
    expect((await dan.get('/teams')).body.teams).toMatchObject([{ id, role: 'admin' }]);
  });

  it('always keeps an admin', async () => {
    const { b: ada, user } = await signUp('ada@example.com');
    const { b: bob, user: bobUser } = await signUp('bob@example.com');
    const id = await createTeam(ada);
    await ada.post(`/teams/${id}/members`, { email: 'bob@example.com', role: 'member' });

    expect((await ada.delete(`/teams/${id}/members/${user.id}`)).status).toBe(400);
    expect((await ada.patch(`/teams/${id}/members/${user.id}`, { role: 'member' })).status).toBe(
      400,
    );

    await ada.patch(`/teams/${id}/members/${bobUser.id}`, { role: 'admin' });
    expect((await ada.delete(`/teams/${id}/members/${user.id}`)).status).toBe(204);
    expect((await bob.get(`/teams/${id}`)).body.team.members).toHaveLength(1);
  });

  it('can be renamed and deleted by admins only', async () => {
    const { b: ada } = await signUp('ada@example.com');
    const { b: bob } = await signUp('bob@example.com');
    const id = await createTeam(ada);
    await ada.post(`/teams/${id}/members`, { email: 'bob@example.com', role: 'member' });

    expect((await bob.patch(`/teams/${id}`, { name: 'x' })).status).toBe(403);
    expect((await bob.delete(`/teams/${id}`)).status).toBe(403);
    expect((await ada.patch(`/teams/${id}`, { name: 'Platform' })).body.team.name).toBe('Platform');
    expect((await ada.delete(`/teams/${id}`)).status).toBe(204);
    expect((await bob.get('/teams')).body.teams).toEqual([]);
  });
});

describe('diagrams shared with a team', () => {
  async function setup() {
    const ada = await signUp('ada@example.com', 'correct horse', 'Ada');
    const bob = await signUp('bob@example.com', 'correct horse', 'Bob');
    const teamId = await createTeam(ada.b);
    await ada.b.post(`/teams/${teamId}/members`, { email: 'bob@example.com', role: 'member' });
    const diagramId = await createDiagram(ada.b);
    return { ada, bob, teamId, diagramId };
  }

  it('gives every member the shared role', async () => {
    const { ada, bob, teamId, diagramId } = await setup();
    expect(
      (await ada.b.post(`/diagrams/${diagramId}/teams`, { teamId, role: 'viewer' })).status,
    ).toBe(204);

    expect((await bob.b.get(`/diagrams/${diagramId}`)).body.diagram).toMatchObject({
      role: 'viewer',
      canWrite: false,
    });
    expect((await put(bob.b, diagramId, 1)).status).toBe(403);

    const list = (await bob.b.get('/diagrams?scope=shared')).body.diagrams;
    expect(list).toMatchObject([{ diagramId, role: 'viewer', teamIds: [teamId] }]);
    const owned = (await ada.b.get('/diagrams')).body.diagrams;
    expect(owned).toMatchObject([
      { diagramId, role: 'owner', sharedWithTeams: 1, teamIds: [teamId] },
    ]);

    // Shown with who has access
    const access = (await bob.b.get(`/diagrams/${diagramId}/members`)).body;
    expect(access.teams).toMatchObject([
      { id: teamId, name: 'Backend', role: 'viewer', memberCount: 2 },
    ]);

    await ada.b.patch(`/diagrams/${diagramId}/teams/${teamId}`, { role: 'editor' });
    expect((await put(bob.b, diagramId, 1)).status).toBe(200);
  });

  it('takes the best of personal and team access', async () => {
    const { ada, bob, teamId, diagramId } = await setup();
    await ada.b.post(`/diagrams/${diagramId}/teams`, { teamId, role: 'viewer' });
    await ada.b.post(`/diagrams/${diagramId}/members`, {
      email: 'bob@example.com',
      role: 'editor',
    });
    expect((await bob.b.get(`/diagrams/${diagramId}`)).body.diagram.role).toBe('editor');
  });

  it('ends access when someone leaves the team or it stops being shared', async () => {
    const { ada, bob, teamId, diagramId } = await setup();
    await ada.b.post(`/diagrams/${diagramId}/teams`, { teamId, role: 'editor' });

    await bob.b.delete(`/teams/${teamId}/members/${bob.user.id}`);
    expect((await bob.b.get(`/diagrams/${diagramId}`)).status).toBe(404);

    await ada.b.post(`/teams/${teamId}/members`, { email: 'bob@example.com', role: 'member' });
    expect((await bob.b.get(`/diagrams/${diagramId}`)).status).toBe(200);
    await ada.b.delete(`/diagrams/${diagramId}/teams/${teamId}`);
    expect((await bob.b.get(`/diagrams/${diagramId}`)).status).toBe(404);
  });

  it('only lets the owner share, and only with their own teams', async () => {
    const { ada, bob, teamId, diagramId } = await setup();
    const { b: eve } = await signUp('eve@example.com');
    const otherTeam = await createTeam(eve, 'Other');

    expect(
      (await ada.b.post(`/diagrams/${diagramId}/teams`, { teamId: otherTeam, role: 'viewer' }))
        .status,
    ).toBe(404);
    await ada.b.post(`/diagrams/${diagramId}/teams`, { teamId, role: 'editor' });
    expect(
      (await bob.b.post(`/diagrams/${diagramId}/teams`, { teamId, role: 'viewer' })).status,
    ).toBe(403);
    expect((await bob.b.delete(`/diagrams/${diagramId}/teams/${teamId}`)).status).toBe(403);
  });
});
