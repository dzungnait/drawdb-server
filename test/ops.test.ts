import { describe, expect, it } from 'vitest';
import { apply, applyAll, diff, isValidOp, Op } from '../src/collab/ops';

const field = (id: string, name: string, extra = {}) => ({ id, name, type: 'INT', ...extra });
const table = (id: string, fields = [field(`${id}f1`, 'id')], extra = {}) => ({
  id,
  name: id,
  x: 0,
  y: 0,
  fields,
  ...extra,
});

const roundTrip = (a: unknown, b: unknown) => expect(applyAll(a, diff(a, b))).toEqual(b);

describe('diff and apply', () => {
  it('round-trips all kinds of changes', () => {
    const a = {
      name: 'Shop',
      tables: [table('t1'), table('t2'), table('t3')],
      references: [],
      notes: [{ id: 0, title: 'a' }],
      types: [{ name: 'money', fields: [] }],
    };
    roundTrip(a, { ...a, name: 'Store' });
    roundTrip(a, { ...a, tables: [table('t2'), table('t1'), table('t3')] });
    roundTrip(a, { ...a, tables: [table('t1'), table('t3')] });
    roundTrip(a, { ...a, tables: [table('t0'), ...a.tables, table('t4')] });
    roundTrip(a, {
      ...a,
      tables: [table('t1', [field('t1f1', 'id'), field('n', 'name')]), table('t2'), table('t3')],
    });
    roundTrip(a, { ...a, notes: [] });
    roundTrip(a, { ...a, types: [] });
    roundTrip(a, { ...a, enums: [{ name: 'e', values: ['x'] }] });
    const withoutNotes: Record<string, unknown> = { ...a };
    delete withoutNotes.notes;
    roundTrip(a, withoutNotes);
  });

  it('describes small edits as small operations', () => {
    const a = { tables: [table('t1'), table('t2')] };
    const b = {
      tables: [table('t1', [field('t1f1', 'uid')]), { ...table('t2'), x: 40 }],
    };
    expect(diff(a, b)).toEqual([
      { t: 'set', p: ['tables', { i: 't1' }, 'fields', { i: 't1f1' }, 'name'], v: 'uid' },
      { t: 'set', p: ['tables', { i: 't2' }, 'x'], v: 40 },
    ]);
  });

  it('lets a deletion win over an edit of what was deleted', () => {
    const state = { tables: [table('t1')] };
    const deleted = apply(state, { t: 'del', p: ['tables'], id: 't1' });
    const edited = apply(deleted, { t: 'set', p: ['tables', { i: 't1' }, 'x'], v: 9 });
    expect(edited).toEqual({ tables: [] });
  });

  it('renumbers index-like ids added at the same time', () => {
    const state = { notes: [{ id: 0, title: 'a' }] };
    const ops: Op[] = [
      { t: 'ins', p: ['notes'], v: { id: 1, title: 'mine' }, a: 0 },
      { t: 'ins', p: ['notes'], v: { id: 1, title: 'theirs' }, a: 0 },
    ];
    expect(applyAll(state, ops).notes.map((n) => [n.id, n.title])).toEqual([
      [0, 'a'],
      [2, 'theirs'],
      [1, 'mine'],
    ]);
  });
});

describe('concurrent edits', () => {
  /**
   * Two clients edit the same base; the server applies A's ops then B's.
   * B rebases: server ops first, then its own again. Both must end equal.
   */
  function converge(base: unknown, a: unknown, b: unknown) {
    const opsA = diff(base, a);
    const opsB = diff(base, b);
    const server = applyAll(applyAll(base, opsA), opsB);
    const clientB = applyAll(applyAll(base, opsA), opsB);
    const clientA = applyAll(applyAll(a, opsA), opsB);
    expect(clientA).toEqual(server);
    expect(clientB).toEqual(server);
    return server as { tables: ReturnType<typeof table>[] };
  }

  it('keeps edits to different fields of the same table', () => {
    const base = { tables: [table('t', [field('f1', 'a'), field('f2', 'b')])] };
    const result = converge(
      base,
      { tables: [table('t', [field('f1', 'A'), field('f2', 'b')])] },
      { tables: [table('t', [field('f1', 'a'), field('f2', 'B')])] },
    );
    expect(result.tables[0].fields.map((f) => f.name)).toEqual(['A', 'B']);
  });

  it('keeps fields added by both people', () => {
    const base = { tables: [table('t', [field('f1', 'id')])] };
    const result = converge(
      base,
      { tables: [table('t', [field('f1', 'id'), field('a', 'from_a')])] },
      { tables: [table('t', [field('f1', 'id'), field('b', 'from_b')])] },
    );
    expect(result.tables[0].fields.map((f) => f.name).sort()).toEqual(['from_a', 'from_b', 'id']);
  });

  it('lets the later edit of the same value win', () => {
    const base = { tables: [table('t')] };
    const result = converge(
      base,
      { tables: [{ ...table('t'), name: 'first' }] },
      { tables: [{ ...table('t'), name: 'second' }] },
    );
    expect(result.tables[0].name).toBe('second');
  });
});

describe('validation', () => {
  it('only accepts well-formed operations on diagram keys', () => {
    expect(isValidOp({ t: 'set', p: ['name'], v: 'x' })).toBe(true);
    expect(isValidOp({ t: 'set', p: ['tables', { i: 't' }, 'x'], v: 1 })).toBe(true);
    expect(isValidOp({ t: 'set', p: ['__proto__'], v: 1 })).toBe(false);
    expect(isValidOp({ t: 'set', p: [], v: {} })).toBe(false);
    expect(isValidOp({ t: 'rm', p: ['name'] })).toBe(false);
    expect(isValidOp({ t: 'ins', p: ['tables'], v: { name: 'no id' }, a: null })).toBe(false);
    expect(isValidOp({ t: 'drop', p: ['tables'] })).toBe(false);
    expect(isValidOp({ t: 'set', p: ['tables', { x: 1 }], v: 1 })).toBe(false);
  });
});
