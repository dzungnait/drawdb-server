import { randomUUID } from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { browser, ORIGIN, resetData, setupDb, signUp } from './helpers';
import { closePool } from '../src/db';
import { setRoomEvents } from '../src/collab/rooms';

beforeAll(setupDb);
afterAll(closePool);

// What would be sent to people with the diagram open
const emitted: { diagramId: string; event: string }[] = [];
beforeEach(async () => {
  await resetData();
  emitted.length = 0;
  setRoomEvents({
    emit: (diagramId, event) => emitted.push({ diagramId, event }),
    revalidate: async () => {},
  });
});

type Browser = ReturnType<typeof browser>;

/** Owner Ada, editor Bob, viewer Cy, and Dan with nothing. */
async function setup() {
  const ada = await signUp('ada@example.com', 'correct horse', 'Ada');
  const bob = await signUp('bob@example.com', 'correct horse', 'Bob');
  const cy = await signUp('cy@example.com', 'correct horse', 'Cy');
  const dan = await signUp('dan@example.com', 'correct horse', 'Dan');
  const id = randomUUID();
  await ada.b.post('/diagrams', { diagramId: id, name: 'Shop', tables: [] });
  await ada.b.post(`/diagrams/${id}/members`, { email: 'bob@example.com', role: 'editor' });
  await ada.b.post(`/diagrams/${id}/members`, { email: 'cy@example.com', role: 'viewer' });
  return { ada, bob, cy, dan, id };
}

const threads = async (b: Browser, id: string) =>
  (await b.get(`/diagrams/${id}/comments`)).body.threads;

describe('comments', () => {
  it('are threads about a table or a field, with replies', async () => {
    const { ada, bob, cy, id } = await setup();
    const started = await bob.b.post(`/diagrams/${id}/comments`, {
      tableId: 'tbl1',
      body: 'Should this be called customers?',
    });
    expect(started.status).toBe(201);
    // Viewers can comment too
    await cy.b.post(`/diagrams/${id}/comments`, { tableId: 'tbl1', fieldId: 3, body: 'Nullable?' });
    const [first] = started.body.threads;
    await ada.b.post(`/diagrams/${id}/comments/${first.id}/replies`, { body: 'Yes, rename it' });

    expect(await threads(cy.b, id)).toMatchObject([
      {
        tableId: 'tbl1',
        fieldId: null,
        resolved: null,
        comments: [
          { author: { name: 'Bob' }, body: 'Should this be called customers?' },
          { author: { name: 'Ada' }, body: 'Yes, rename it' },
        ],
      },
      { tableId: 'tbl1', fieldId: '3', comments: [{ author: { name: 'Cy' } }] },
    ]);
    expect(emitted).toEqual(Array(3).fill({ diagramId: id, event: 'comments' }));
  });

  it('are only for people the diagram is shared with', async () => {
    const { ada, dan, id } = await setup();
    expect((await dan.b.get(`/diagrams/${id}/comments`)).status).toBe(404);
    expect(
      (await dan.b.post(`/diagrams/${id}/comments`, { tableId: 't', body: 'hi' })).status,
    ).toBe(404);

    // Not with just a link: comments show who wrote them
    const { links } = (
      await ada.b.agent.put(`/diagrams/${id}/links/editor`).set('Origin', ORIGIN).send({})
    ).body;
    const viaLink = await dan.b.agent
      .get(`/diagrams/${id}/comments`)
      .set('Origin', ORIGIN)
      .set('X-Share-Link', links[0].token);
    expect(viaLink.status).toBe(403);

    const anon = browser();
    expect((await anon.get(`/diagrams/${id}/comments`)).status).toBe(401);
  });

  it('can be resolved, and a reply opens them again', async () => {
    const { ada, bob, id } = await setup();
    const [thread] = (
      await bob.b.post(`/diagrams/${id}/comments`, { tableId: 't', body: 'Add an index' })
    ).body.threads;
    await ada.b.post(`/diagrams/${id}/comments/${thread.id}/resolve`, { resolved: true });
    expect((await threads(bob.b, id))[0].resolved).toMatchObject({ by: 'Ada' });

    await bob.b.post(`/diagrams/${id}/comments/${thread.id}/replies`, { body: 'Not done yet' });
    expect((await threads(bob.b, id))[0].resolved).toBeNull();

    await bob.b.post(`/diagrams/${id}/comments/${thread.id}/resolve`, { resolved: true });
    await bob.b.post(`/diagrams/${id}/comments/${thread.id}/resolve`, { resolved: false });
    expect((await threads(bob.b, id))[0].resolved).toBeNull();
  });

  it('are edited by their author and deleted by them or the owner', async () => {
    const { ada, bob, cy, id } = await setup();
    const [thread] = (await bob.b.post(`/diagrams/${id}/comments`, { tableId: 't', body: 'Typo' }))
      .body.threads;
    const replied = await cy.b.post(`/diagrams/${id}/comments/${thread.id}/replies`, {
      body: 'Where?',
    });
    const replyId = replied.body.threads[0].comments[1].id;

    expect((await ada.b.patch(`/diagrams/${id}/comments/${thread.id}`, { body: 'x' })).status).toBe(
      403,
    );
    const edited = await bob.b.patch(`/diagrams/${id}/comments/${thread.id}`, {
      body: 'Typo in the name',
    });
    expect(edited.body.threads[0].comments[0]).toMatchObject({ body: 'Typo in the name' });
    expect(edited.body.threads[0].comments[0].editedAt).toBeTruthy();

    // Someone else's comment: only the owner may delete it
    expect((await bob.b.delete(`/diagrams/${id}/comments/${replyId}`)).status).toBe(403);
    expect((await ada.b.delete(`/diagrams/${id}/comments/${replyId}`)).status).toBe(200);
    // The first comment takes the thread with it
    await bob.b.post(`/diagrams/${id}/comments/${thread.id}/replies`, { body: 'Fixed' });
    expect((await bob.b.delete(`/diagrams/${id}/comments/${thread.id}`)).body.threads).toEqual([]);
  });

  it('check their input', async () => {
    const { bob, id } = await setup();
    const post = (body: object) => bob.b.post(`/diagrams/${id}/comments`, body);
    expect((await post({ tableId: 't', body: '   ' })).status).toBe(400);
    expect((await post({ tableId: 't', body: 'x'.repeat(5001) })).status).toBe(400);
    expect((await post({ body: 'no table' })).status).toBe(400);
    expect((await bob.b.post(`/diagrams/${id}/comments/999/replies`, { body: 'hi' })).status).toBe(
      404,
    );
  });
});
