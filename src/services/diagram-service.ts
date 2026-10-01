import { config } from '../config';
import { query, queryOne } from '../db';
import { conflict, forbidden, HttpError, notFound } from '../utils/http-error';
import { UserRow } from './user-service';

export interface DiagramRow {
  id: string;
  owner_id: string;
  name: string;
  database: string;
  content: Record<string, unknown>;
  size_bytes: number;
  version: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

interface DiagramWithOwner extends DiagramRow {
  owner_name: string;
  owner_email: string;
}

export interface DiagramInput {
  name: string;
  database: string;
  content: Record<string, unknown>;
}

export type Role = 'owner';

/** The caller's role on a diagram, or null without access. */
function roleOf(diagram: DiagramRow, user: UserRow): Role | null {
  return diagram.owner_id === user.id ? 'owner' : null;
}

const canWrite = (role: Role | null) => role === 'owner';

const SELECT_WITH_OWNER = `
  SELECT d.*, u.name AS owner_name, u.email AS owner_email
    FROM diagrams d JOIN users u ON u.id = d.owner_id`;

const owner = (row: DiagramWithOwner) => ({ id: row.owner_id, username: row.owner_name, email: row.owner_email });

/** List entry, shaped like the editor's local diagrams. */
const summary = (row: DiagramWithOwner) => ({
  diagramId: row.id,
  name: row.name,
  database: row.database,
  owner: owner(row),
  sizeBytes: row.size_bytes,
  version: row.version,
  lastModified: row.updated_at,
  deletedAt: row.deleted_at,
});

/** Full diagram, in the shape the editor loads. */
const full = (row: DiagramWithOwner, role: Role) => ({
  ...row.content,
  diagramId: row.id,
  name: row.name,
  database: row.database,
  owner: owner(row),
  version: row.version,
  lastModified: row.updated_at,
  role,
  canWrite: canWrite(role),
});

const sizeOf = (content: unknown) => Buffer.byteLength(JSON.stringify(content));

async function load(id: string, user: UserRow, { includeDeleted = false } = {}) {
  const row = await queryOne<DiagramWithOwner>(`${SELECT_WITH_OWNER} WHERE d.id = $1`, [id]);
  // No access looks the same as not existing, so ids can't be probed
  const role = row ? roleOf(row, user) : null;
  if (!row || !role || (row.deleted_at && !includeDeleted)) throw notFound('diagram_not_found');
  return { row, role };
}

export async function listDiagrams(user: UserRow, { trash = false } = {}) {
  const rows = await query<DiagramWithOwner>(
    `${SELECT_WITH_OWNER}
      WHERE d.owner_id = $1 AND (d.deleted_at IS NOT NULL) = $2
      ORDER BY ${trash ? 'd.deleted_at' : 'd.updated_at'} DESC`,
    [user.id, trash],
  );
  return rows.map(summary);
}

export async function getDiagram(id: string, user: UserRow) {
  const { row, role } = await load(id, user);
  return full(row, role);
}

export async function createDiagram(user: UserRow, id: string, input: DiagramInput) {
  const count = await queryOne<{ n: number }>(
    'SELECT count(*)::int AS n FROM diagrams WHERE owner_id = $1',
    [user.id],
  );
  if (count!.n >= config.limits.diagramsPerUser) {
    throw new HttpError(403, 'diagram_limit_reached', `You can keep up to ${config.limits.diagramsPerUser} diagrams`);
  }
  try {
    await query(
      `INSERT INTO diagrams (id, owner_id, name, database, content, size_bytes)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, user.id, input.name, input.database, input.content, sizeOf(input.content)],
    );
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw conflict('diagram_exists');
    throw e;
  }
  return getDiagram(id, user);
}

/**
 * Saves a new state of the diagram. `baseVersion` is the version the
 * client last loaded or saved; if someone saved since, it's a conflict
 * unless `force` is set.
 */
export async function updateDiagram(
  id: string,
  user: UserRow,
  input: DiagramInput,
  { baseVersion, force = false }: { baseVersion?: number; force?: boolean },
) {
  const { row, role } = await load(id, user);
  if (!canWrite(role)) throw forbidden('read_only');

  const updated = await queryOne<{ version: number; updated_at: Date }>(
    `UPDATE diagrams
        SET name = $3, database = $4, content = $5, size_bytes = $6,
            version = version + 1, updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL AND ($7 OR version = $2)
      RETURNING version, updated_at`,
    [id, baseVersion ?? -1, input.name, input.database, input.content, sizeOf(input.content), force],
  );
  if (!updated) {
    const current = await queryOne<{ version: number; updated_at: Date }>(
      'SELECT version, updated_at FROM diagrams WHERE id = $1',
      [id],
    );
    throw new HttpError(409, 'version_conflict', 'The diagram was changed elsewhere', {
      version: current?.version ?? row.version,
      lastModified: current?.updated_at ?? row.updated_at,
    });
  }
  return { diagramId: id, version: updated.version, lastModified: updated.updated_at };
}

export async function trashDiagram(id: string, user: UserRow) {
  const { role } = await load(id, user);
  if (role !== 'owner') throw forbidden('owner_only');
  await query('UPDATE diagrams SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL', [id]);
}

export async function restoreDiagram(id: string, user: UserRow) {
  const { role } = await load(id, user, { includeDeleted: true });
  if (role !== 'owner') throw forbidden('owner_only');
  await query('UPDATE diagrams SET deleted_at = NULL WHERE id = $1', [id]);
  return getDiagram(id, user);
}

export async function deleteDiagramForever(id: string, user: UserRow) {
  const { row, role } = await load(id, user, { includeDeleted: true });
  if (role !== 'owner') throw forbidden('owner_only');
  // Only from the trash, so a single request can't destroy live work
  if (!row.deleted_at) throw conflict('not_in_trash', 'Move the diagram to the trash first');
  await query('DELETE FROM diagrams WHERE id = $1', [id]);
}

export async function purgeTrash() {
  await query(
    `DELETE FROM diagrams WHERE deleted_at < now() - make_interval(days => $1)`,
    [config.limits.trashDays],
  );
}
