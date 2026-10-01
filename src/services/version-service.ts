import { query, queryOne, transaction } from '../db';
import { forbidden, notFound } from '../utils/http-error';
import { canWrite, getDiagram, load } from './diagram-service';
import { keepCurrent, saveCurrent, SnapshotKind } from './snapshots';
import { UserRow } from './user-service';

interface VersionRow {
  id: string;
  diagram_id: string;
  diagram_version: number;
  kind: SnapshotKind;
  label: string | null;
  name: string;
  database: string;
  size_bytes: number;
  author_id: string | null;
  author_name: string | null;
  created_at: Date;
}

const META_COLUMNS = `v.id, v.diagram_id, v.diagram_version, v.kind, v.label, v.name, v.database,
  v.size_bytes, v.author_id, u.name AS author_name, v.created_at`;

const author = (id: string | null, name: string | null) => (id ? { id, username: name } : null);

const meta = (row: VersionRow) => ({
  id: row.id,
  kind: row.kind,
  label: row.label,
  diagramVersion: row.diagram_version,
  name: row.name,
  database: row.database,
  sizeBytes: row.size_bytes,
  author: author(row.author_id, row.author_name),
  createdAt: row.created_at,
});

/** History is for people who can edit the diagram. */
async function loadForEditing(diagramId: string, user: UserRow) {
  const access = await load(diagramId, user);
  if (!canWrite(access.role)) throw forbidden('read_only');
  return access;
}

async function loadVersion(diagramId: string, versionId: string, columns = META_COLUMNS) {
  const row = await queryOne<VersionRow & { content?: Record<string, unknown> }>(
    `SELECT ${columns} FROM diagram_versions v LEFT JOIN users u ON u.id = v.author_id
      WHERE v.id = $1 AND v.diagram_id = $2`,
    [versionId, diagramId],
  );
  if (!row) throw notFound('version_not_found');
  return row;
}

/** Newest first, `limit` at a time; `before` is the last id of the previous page. */
export async function listVersions(
  diagramId: string,
  user: UserRow,
  { before, limit = 50 }: { before?: string; limit?: number } = {},
) {
  const { row } = await loadForEditing(diagramId, user);
  const rows = await query<VersionRow>(
    `SELECT ${META_COLUMNS} FROM diagram_versions v LEFT JOIN users u ON u.id = v.author_id
      WHERE v.diagram_id = $1 AND ($2::bigint IS NULL OR v.id < $2)
      ORDER BY v.id DESC LIMIT $3`,
    [diagramId, before ?? null, limit + 1],
  );
  const editor = row.updated_by
    ? await queryOne<{ name: string }>('SELECT name FROM users WHERE id = $1', [row.updated_by])
    : null;
  return {
    current: {
      diagramVersion: row.version,
      lastModified: row.updated_at,
      author: author(editor ? row.updated_by : null, editor?.name ?? null),
    },
    versions: rows.slice(0, limit).map(meta),
    hasMore: rows.length > limit,
  };
}

/** A version with its content, in the shape the editor loads. */
export async function getVersion(diagramId: string, versionId: string, user: UserRow) {
  await loadForEditing(diagramId, user);
  const row = await loadVersion(diagramId, versionId, `${META_COLUMNS}, v.content`);
  return { ...meta(row), diagram: { ...row.content, name: row.name, database: row.database } };
}

export async function createVersion(diagramId: string, user: UserRow, label: string | null) {
  await loadForEditing(diagramId, user);
  const id = await transaction(async (db) => {
    await db.query('SELECT 1 FROM diagrams WHERE id = $1 FOR UPDATE', [diagramId]);
    return saveCurrent(db, diagramId, user.id, label);
  });
  return meta(await loadVersion(diagramId, id));
}

export async function renameVersion(diagramId: string, versionId: string, user: UserRow, label: string | null) {
  await loadForEditing(diagramId, user);
  await loadVersion(diagramId, versionId);
  await query('UPDATE diagram_versions SET label = $2 WHERE id = $1', [versionId, label]);
  return meta(await loadVersion(diagramId, versionId));
}

export async function deleteVersion(diagramId: string, versionId: string, user: UserRow) {
  const { role } = await loadForEditing(diagramId, user);
  if (role !== 'owner') throw forbidden('owner_only');
  await loadVersion(diagramId, versionId);
  await query('DELETE FROM diagram_versions WHERE id = $1', [versionId]);
}

/**
 * Makes a version the diagram's current state. What it replaces is kept,
 * so a restore can itself be undone.
 */
export async function restoreVersion(diagramId: string, versionId: string, user: UserRow) {
  await loadForEditing(diagramId, user);
  await loadVersion(diagramId, versionId);
  await transaction(async (db) => {
    await db.query('SELECT 1 FROM diagrams WHERE id = $1 FOR UPDATE', [diagramId]);
    await keepCurrent(db, diagramId, 'pre_restore');
    await db.query(
      `UPDATE diagrams d
          SET name = v.name, database = v.database, content = v.content, size_bytes = v.size_bytes,
              updated_by = $3, version = d.version + 1, updated_at = now()
         FROM diagram_versions v
        WHERE d.id = $1 AND v.id = $2`,
      [diagramId, versionId, user.id],
    );
  });
  return getDiagram(diagramId, user);
}
