/**
 * Changes to a diagram as small operations, so concurrent edits to
 * different things don't overwrite each other.
 *
 * A path walks the diagram: string segments are object keys, `{ i: id }`
 * picks the element with that id from an array of objects with ids
 * (tables, fields, relationships...). Anything else (strings, numbers,
 * arrays without ids) is replaced as a whole.
 *
 * The frontend has the same algorithm in src/cloud/collab/ops.js; keep
 * both in step.
 */

type Id = string | number;
export type Segment = string | { i: Id };
export type Path = Segment[];

export type Op =
  | { t: 'set'; p: Path; v: unknown } // set a value (an object key or a whole value)
  | { t: 'rm'; p: Path } // remove an object key
  | { t: 'ins'; p: Path; v: Record<string, unknown> & { id: Id }; a: Id | null } // insert after id `a` (null: first)
  | { t: 'del'; p: Path; id: Id } // remove the element with this id
  | { t: 'ord'; p: Path; ids: Id[] }; // reorder elements

type Json = unknown;
type Obj = Record<string, Json>;
type Item = Obj & { id: Id };

const isObject = (v: Json): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

const hasId = (v: Json): v is Item =>
  isObject(v) && (typeof v.id === 'string' || typeof v.id === 'number');

/** An array of objects with ids: elements are tracked one by one. */
const isIdArray = (v: Json): v is Item[] => Array.isArray(v) && v.every(hasId);

export function equal(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((x, i) => equal(x, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => equal(a[k], b[k]));
  }
  return false;
}

/** The operations that turn `a` into `b`. */
export function diff(a: Json, b: Json, path: Path = [], ops: Op[] = []): Op[] {
  if (equal(a, b)) return ops;

  // Both empty-or-with-ids, and at least one non-empty
  if (isIdArray(a) && isIdArray(b)) {
    const before = new Map(a.map((x) => [x.id, x]));
    const after = new Set(b.map((x) => x.id));
    for (const x of a) if (!after.has(x.id)) ops.push({ t: 'del', p: path, id: x.id });
    let previous: Id | null = null;
    for (const x of b) {
      const old = before.get(x.id);
      if (old === undefined) ops.push({ t: 'ins', p: path, v: x, a: previous });
      else diff(old, x, [...path, { i: x.id }], ops);
      previous = x.id;
    }
    const kept = a.map((x) => x.id).filter((id) => after.has(id));
    const keptAfter = b.map((x) => x.id).filter((id) => before.has(id));
    if (!equal(kept, keptAfter)) ops.push({ t: 'ord', p: path, ids: b.map((x) => x.id) });
    return ops;
  }

  if (isObject(a) && isObject(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (b[key] === undefined) {
        if (a[key] !== undefined) ops.push({ t: 'rm', p: [...path, key] });
      } else {
        diff(a[key], b[key], [...path, key], ops);
      }
    }
    return ops;
  }

  ops.push({ t: 'set', p: path, v: b });
  return ops;
}

const NOT_FOUND = Symbol('not found');

/** Returns `value` with `fn` applied at `path`, or NOT_FOUND. */
function update(
  value: Json,
  path: Path,
  fn: (v: Json) => Json | typeof NOT_FOUND,
): Json | typeof NOT_FOUND {
  if (path.length === 0) return fn(value);
  const [head, ...rest] = path;
  if (typeof head === 'string') {
    if (!isObject(value)) return NOT_FOUND;
    const next = update(value[head], rest, fn);
    return next === NOT_FOUND ? NOT_FOUND : { ...value, [head]: next };
  }
  if (!Array.isArray(value)) return NOT_FOUND;
  const index = value.findIndex((x) => hasId(x) && x.id === head.i);
  if (index === -1) return NOT_FOUND;
  const next = update(value[index], rest, fn);
  if (next === NOT_FOUND) return NOT_FOUND;
  const copy = value.slice();
  copy[index] = next;
  return copy;
}

function applyToArray(list: Json, op: Extract<Op, { t: 'ins' | 'del' | 'ord' }>) {
  const items = Array.isArray(list) ? (list as Item[]) : list === undefined ? [] : null;
  if (!items) return NOT_FOUND;
  switch (op.t) {
    case 'ins': {
      let item = op.v;
      if (items.some((x) => x.id === item.id)) {
        // Two people added an element with the same id at once. Index-like
        // numeric ids (notes, areas) get the next free number; string ids
        // are random, so it's a replay and is skipped.
        if (typeof item.id !== 'number') return NOT_FOUND;
        const max = Math.max(...items.map((x) => (typeof x.id === 'number' ? x.id : -1)));
        item = { ...item, id: max + 1 };
      }
      const copy = items.slice();
      const at = op.a === null ? 0 : copy.findIndex((x) => x.id === op.a) + 1;
      copy.splice(op.a !== null && at === 0 ? copy.length : at, 0, item);
      return copy;
    }
    case 'del': {
      const copy = items.filter((x) => x.id !== op.id);
      return copy.length === items.length ? NOT_FOUND : copy;
    }
    case 'ord': {
      const rank = new Map(op.ids.map((id, i) => [id, i]));
      // Elements not in the list (added meanwhile) go last, in their order
      return items
        .map((x, i) => ({ x, key: rank.get(x.id) ?? op.ids.length + i }))
        .sort((p, q) => p.key - q.key)
        .map((p) => p.x);
    }
  }
}

/**
 * Applies one operation. Operations on things that no longer exist
 * (deleted meanwhile) do nothing, so a deletion wins over an edit.
 */
export function apply<T>(state: T, op: Op): T {
  let result: Json | typeof NOT_FOUND;
  switch (op.t) {
    case 'set':
      result =
        op.p.length === 0
          ? op.v
          : update(state, op.p.slice(0, -1), (parent) =>
              setIn(parent, op.p[op.p.length - 1], op.v),
            );
      break;
    case 'rm':
      result = update(state, op.p.slice(0, -1), (parent) => {
        const key = op.p[op.p.length - 1];
        if (!isObject(parent) || typeof key !== 'string' || !(key in parent)) return NOT_FOUND;
        const copy = { ...parent };
        delete copy[key];
        return copy;
      });
      break;
    default:
      result = update(state, op.p, (list) => applyToArray(list, op));
  }
  return result === NOT_FOUND ? state : (result as T);
}

function setIn(parent: Json, key: Segment, value: Json): Json | typeof NOT_FOUND {
  if (typeof key === 'string') {
    // Only into objects; a missing parent means it was deleted
    return isObject(parent) ? { ...parent, [key]: value } : NOT_FOUND;
  }
  if (!Array.isArray(parent)) return NOT_FOUND;
  const index = parent.findIndex((x) => hasId(x) && x.id === key.i);
  if (index === -1) return NOT_FOUND;
  const copy = parent.slice();
  copy[index] = value;
  return copy;
}

export const applyAll = <T>(state: T, ops: Op[]): T => ops.reduce((s, op) => apply(s, op), state);

/** The top-level keys of a diagram that operations may touch. */
export const DIAGRAM_KEYS = new Set([
  'name',
  'database',
  'tables',
  'references',
  'notes',
  'areas',
  'views',
  'types',
  'enums',
]);

const MAX_DEPTH = 12;

/** Rejects malformed operations from clients. */
export function isValidOp(op: unknown): op is Op {
  if (!isObject(op) || typeof op.t !== 'string' || !Array.isArray(op.p)) return false;
  const path = op.p as unknown[];
  if (path.length > MAX_DEPTH) return false;
  const segmentsOk = path.every(
    (s) =>
      typeof s === 'string' ||
      (isObject(s) && (typeof s.i === 'string' || typeof s.i === 'number')),
  );
  // Everything lives under a known top-level key
  if (!segmentsOk || path.length === 0 || !DIAGRAM_KEYS.has(path[0] as string)) return false;
  const isId = (v: unknown) => typeof v === 'string' || typeof v === 'number';
  switch (op.t) {
    case 'set':
      return 'v' in op;
    case 'rm':
      return path.length > 1;
    case 'ins':
      return hasId(op.v) && (op.a === null || isId(op.a));
    case 'del':
      return isId(op.id);
    case 'ord':
      return Array.isArray(op.ids) && op.ids.every(isId);
    default:
      return false;
  }
}
