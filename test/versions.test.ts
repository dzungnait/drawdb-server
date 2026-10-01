import { randomUUID } from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { browser, ORIGIN, resetData, setupDb, signUp } from './helpers';
import { closePool, query } from '../src/db';
import { purgeVersions } from '../src/services/snapshots';

beforeAll(setupDb);
beforeEach(resetData);
afterAll(closePool);

type Browser = ReturnType<typeof browser>;

const table = (name: string) => ({ id: name, name, fields: [] });

async function create(b: Browser) {
  const diagramId = randomUUID();
  const res = await b.post('/diagrams', {
    diagramId,
    name: 'Shop',
    database: 'postgresql',
    tables: [table('v1')],
  });
  expect(res.status).toBe(201);
  return diagramId;
}

/** Saves a state based on the current version, like the editor does. */
async function save(
  b: Browser,
  id: string,
  tableName: string,
  extra: Record<string, unknown> = {},
) {
  const { version } = (await b.get(`/diagrams/${id}`)).body.diagram;
  const res = await b.agent
    .put(`/diagrams/${id}`)
    .set('Origin', ORIGIN)
    .send({
      name: 'Shop',
      database: 'postgresql',
      tables: [table(tableName)],
      baseVersion: version,
      ...extra,
    });
  expect(res.status).toBe(200);
  return res.body.version as number;
}

const history = async (b: Browser, id: string, q = '') => {
  const res = await b.get(`/diagrams/${id}/versions${q}`);
  expect(res.status).toBe(200);
  return res.body;
};

/** Pretend every snapshot was taken long ago. */
const ageSnapshots = (minutes = 60) =>
  query(`UPDATE diagram_versions SET created_at = created_at - make_interval(mins => $1)`, [
    minutes,
  ]);

describe('automatic versions', () => {
  it('keeps the state before an editing session, then at most every few minutes', async () => {
    const { b, user } = await signUp();
    const id = await create(b);

    await save(b, id, 'v2'); // keeps v1
    await save(b, id, 'v3'); // too soon
    await ageSnapshots();
    await save(b, id, 'v4'); // keeps v3

    const h = await history(b, id);
    expect(h.current).toMatchObject({
      diagramVersion: 4,
      author: { id: user.id, username: 'Ada' },
    });
    expect(
      h.versions.map((v: { diagramVersion: number; kind: string }) => [v.diagramVersion, v.kind]),
    ).toEqual([
      [3, 'auto'],
      [1, 'auto'],
    ]);
    expect(h.versions[0]).toMatchObject({ label: null, name: 'Shop', author: { id: user.id } });
    expect(h.hasMore).toBe(false);
  });

  it('always keeps what a forced save overwrites', async () => {
    const { b } = await signUp();
    const id = await create(b);
    await save(b, id, 'v2'); // keeps v1, so the next one isn't due

    await save(b, id, 'mine', { baseVersion: 1, force: true });
    const { versions } = await history(b, id);
    expect(versions[0]).toMatchObject({ kind: 'pre_overwrite', diagramVersion: 2 });

    const kept = await b.get(`/diagrams/${id}/versions/${versions[0].id}`);
    expect(kept.body.version.diagram.tables[0].name).toBe('v2');
  });
});

describe('named versions', () => {
  it('saves the current state under a name', async () => {
    const { b } = await signUp();
    const id = await create(b);
    await save(b, id, 'v2');

    const res = await b.post(`/diagrams/${id}/versions`, { label: '  Release 1  ' });
    expect(res.status).toBe(201);
    expect(res.body.version).toMatchObject({
      kind: 'manual',
      label: 'Release 1',
      diagramVersion: 2,
    });

    const got = await b.get(`/diagrams/${id}/versions/${res.body.version.id}`);
    expect(got.body.version.diagram).toMatchObject({
      name: 'Shop',
      database: 'postgresql',
      tables: [table('v2')],
    });
  });

  it('renames and deletes', async () => {
    const { b } = await signUp();
    const id = await create(b);
    const { body } = await b.post(`/diagrams/${id}/versions`, { label: 'Draft' });

    const renamed = await b.patch(`/diagrams/${id}/versions/${body.version.id}`, {
      label: 'Final',
    });
    expect(renamed.body.version.label).toBe('Final');
    const cleared = await b.patch(`/diagrams/${id}/versions/${body.version.id}`, { label: '' });
    expect(cleared.body.version).toMatchObject({ label: null, kind: 'manual' });

    expect((await b.delete(`/diagrams/${id}/versions/${body.version.id}`)).status).toBe(204);
    expect((await b.get(`/diagrams/${id}/versions/${body.version.id}`)).status).toBe(404);
  });
});

describe('restore', () => {
  it('makes a version current and keeps what it replaced', async () => {
    const { b } = await signUp();
    const id = await create(b);
    await save(b, id, 'v2'); // keeps v1
    const [v1] = (await history(b, id)).versions;

    const res = await b.post(`/diagrams/${id}/versions/${v1.id}/restore`);
    expect(res.status).toBe(200);
    expect(res.body.diagram).toMatchObject({ version: 3, tables: [table('v1')], canWrite: true });

    const { versions } = await history(b, id);
    expect(versions[0]).toMatchObject({ kind: 'pre_restore', diagramVersion: 2 });

    // Undo the restore
    const undo = await b.post(`/diagrams/${id}/versions/${versions[0].id}/restore`);
    expect(undo.body.diagram).toMatchObject({ version: 4, tables: [table('v2')] });
  });

  it('makes open copies conflict on their next save', async () => {
    const { b } = await signUp();
    const id = await create(b);
    await save(b, id, 'v2');
    const [v1] = (await history(b, id)).versions;
    await b.post(`/diagrams/${id}/versions/${v1.id}/restore`);

    const stale = await b.agent
      .put(`/diagrams/${id}`)
      .set('Origin', ORIGIN)
      .send({ name: 'Shop', tables: [], baseVersion: 2 });
    expect(stale.status).toBe(409);
  });
});

describe('access', () => {
  it("is limited to the diagram's editors", async () => {
    const { b: ada } = await signUp('ada@example.com');
    const { b: bob } = await signUp('bob@example.com');
    const id = await create(ada);
    const { body } = await ada.post(`/diagrams/${id}/versions`, { label: 'x' });
    const vid = body.version.id;

    expect((await bob.get(`/diagrams/${id}/versions`)).status).toBe(404);
    expect((await bob.get(`/diagrams/${id}/versions/${vid}`)).status).toBe(404);
    expect((await bob.post(`/diagrams/${id}/versions`, {})).status).toBe(404);
    expect((await bob.post(`/diagrams/${id}/versions/${vid}/restore`)).status).toBe(404);
    expect((await bob.patch(`/diagrams/${id}/versions/${vid}`, { label: 'y' })).status).toBe(404);
    expect((await bob.delete(`/diagrams/${id}/versions/${vid}`)).status).toBe(404);
  });

  it("doesn't mix up versions of different diagrams", async () => {
    const { b } = await signUp();
    const a = await create(b);
    const other = await create(b);
    const { body } = await b.post(`/diagrams/${a}/versions`, {});
    expect((await b.get(`/diagrams/${other}/versions/${body.version.id}`)).status).toBe(404);
    expect((await b.post(`/diagrams/${other}/versions/${body.version.id}/restore`)).status).toBe(
      404,
    );
  });

  it('hides the history of diagrams in the trash and rejects bad ids', async () => {
    const { b } = await signUp();
    const id = await create(b);
    await b.delete(`/diagrams/${id}`);
    expect((await b.get(`/diagrams/${id}/versions`)).status).toBe(404);
    expect((await b.get(`/diagrams/${randomUUID()}/versions/abc`)).status).toBe(400);
  });
});

describe('listing', () => {
  it('pages newest first', async () => {
    const { b } = await signUp();
    const id = await create(b);
    for (let i = 0; i < 5; i++) await b.post(`/diagrams/${id}/versions`, { label: `n${i}` });

    const first = await history(b, id, '?limit=2');
    expect(first.versions.map((v: { label: string }) => v.label)).toEqual(['n4', 'n3']);
    expect(first.hasMore).toBe(true);
    const rest = await history(b, id, `?limit=10&before=${first.versions[1].id}`);
    expect(rest.versions.map((v: { label: string }) => v.label)).toEqual(['n2', 'n1', 'n0']);
    expect(rest.hasMore).toBe(false);
  });

  it('deletes versions with their diagram', async () => {
    const { b } = await signUp();
    const id = await create(b);
    await b.post(`/diagrams/${id}/versions`, {});
    await b.delete(`/diagrams/${id}`);
    await b.delete(`/diagrams/${id}/permanent`);
    expect(await query('SELECT 1 FROM diagram_versions')).toHaveLength(0);
  });
});

describe('purging', () => {
  it('thins out unnamed versions over time and keeps named ones', async () => {
    const { b } = await signUp();
    const id = await create(b);
    // `at` is SQL relative to now; the tag (stored as the name) identifies the row
    const add = (tag: string, at: string, kind = 'auto', label: string | null = null) =>
      query(
        `INSERT INTO diagram_versions (diagram_id, diagram_version, kind, label, name, database, content, size_bytes, created_at)
         VALUES ($1, 1, $2, $3, $4, 'generic', '{}', 2, ${at})`,
        [id, kind, label, tag],
      );
    const hour = (h: number, m: number) =>
      `date_trunc('hour', now()) - interval '${h} hours' + interval '${m} minutes'`;
    const day = (d: number, h: number) =>
      `date_trunc('day', now()) - interval '${d} days' + interval '${h} hours'`;

    // Within the last day: all kept
    await add('recent-a', "now() - interval '1 hour'");
    await add('recent-b', "now() - interval '2 hours'");
    // 1-7 days ago: the latest of each hour
    await add('hour-old', hour(50, 10));
    await add('hour-new', hour(50, 20));
    await add('other-hour', hour(52, 10));
    // Older: the latest of each day
    await add('day-old', day(10, 1));
    await add('day-new', day(10, 3));
    // Past retention (90 days)
    await add('expired', day(100, 1));
    // Named, or saved on purpose: never purged
    await add('named', day(100, 2), 'auto', 'keep');
    await add('manual', day(100, 3), 'manual');

    await purgeVersions();
    const left = await query<{ name: string }>('SELECT name FROM diagram_versions ORDER BY name');
    expect(left.map((r) => r.name)).toEqual([
      'day-new',
      'hour-new',
      'manual',
      'named',
      'other-hour',
      'recent-a',
      'recent-b',
    ]);
  });
});
