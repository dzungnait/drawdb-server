import { config, mailEnabled } from '../config';
import { query, queryOne, transaction } from '../db';
import { conflict, forbidden, HttpError, notFound } from '../utils/http-error';
import { currentShareLink } from '../utils/request-context';
import { flushRoom, reloadRoom, revalidateRoom } from '../collab/rooms';
import { keepCurrent, keepCurrentIfDue } from './snapshots';
import { UserRow } from './user-service';

export interface DiagramRow {
  id: string;
  owner_id: string;
  name: string;
  database: string;
  content: Record<string, unknown>;
  size_bytes: number;
  version: number;
  updated_by: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

interface DiagramWithOwner extends DiagramRow {
  owner_name: string;
  owner_email: string;
  /** The caller's membership role, if the diagram is shared with them. */
  member_role: MemberRole | null;
  member_count: number;
}

export interface DiagramInput {
  name: string;
  database: string;
  content: Record<string, unknown>;
}

export type MemberRole = 'editor' | 'viewer';
export type Role = 'owner' | MemberRole;

/** The caller's role on a diagram, or null without access. */
function roleOf(diagram: DiagramWithOwner, user: UserRow | null): Role | null {
  if (!user) return null;
  return diagram.owner_id === user.id ? 'owner' : diagram.member_role;
}

const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

/** How the caller got their role: they own it, it's shared with them, or a link. */
export type Via = 'owner' | 'member' | 'link';

interface Access {
  row: DiagramWithOwner;
  role: Role;
  via: Via;
  /** Opened with an edit link while signed out: signing in allows editing. */
  signInToEdit: boolean;
}

export const canWrite = (role: Role | null) => role === 'owner' || role === 'editor';

/** Diagrams with their owner and the role of user $1 on them. */
const SELECT_FOR_USER = `
  SELECT d.*, u.name AS owner_name, u.email AS owner_email, m.role AS member_role,
         (SELECT count(*)::int FROM diagram_members dm WHERE dm.diagram_id = d.id) AS member_count
    FROM diagrams d
    JOIN users u ON u.id = d.owner_id
    LEFT JOIN diagram_members m ON m.diagram_id = d.id AND m.user_id = $1`;

const owner = (row: DiagramWithOwner) => ({
  id: row.owner_id,
  username: row.owner_name,
  email: row.owner_email,
});

/** List entry, shaped like the editor's local diagrams. */
const summary = (row: DiagramWithOwner, user: UserRow) => ({
  diagramId: row.id,
  name: row.name,
  database: row.database,
  owner: owner(row),
  role: roleOf(row, user),
  sharedWith: row.member_count,
  sizeBytes: row.size_bytes,
  version: row.version,
  lastModified: row.updated_at,
  deletedAt: row.deleted_at,
});

/** Full diagram, in the shape the editor loads. */
const full = ({ row, role, via, signInToEdit }: Access) => ({
  ...row.content,
  diagramId: row.id,
  name: row.name,
  database: row.database,
  owner: owner(row),
  version: row.version,
  lastModified: row.updated_at,
  role,
  canWrite: canWrite(role),
  access: via,
  signInToEdit,
});

export const sizeOf = (content: unknown) => Buffer.byteLength(JSON.stringify(content));

/**
 * Turns invitations sent to the user's email into memberships. Only once
 * the email is proven theirs, unless the server can't send mail at all
 * (then nobody can verify, and the email is taken on trust).
 */
export async function claimInvites(user: UserRow) {
  if (!user.email_verified_at && mailEnabled()) return;
  await query(
    `WITH claimed AS (DELETE FROM diagram_invites WHERE email = $2 RETURNING diagram_id, role, invited_by)
     INSERT INTO diagram_members (diagram_id, user_id, role, invited_by)
     SELECT c.diagram_id, $1, c.role, c.invited_by
       FROM claimed c JOIN diagrams d ON d.id = c.diagram_id
      WHERE d.owner_id <> $1
     ON CONFLICT (diagram_id, user_id) DO NOTHING`,
    [user.id, user.email],
  );
}

// Signed out matches no membership
const NOBODY = '00000000-0000-0000-0000-000000000000';

const fetchForUser = (id: string, user: UserRow | null) =>
  queryOne<DiagramWithOwner>(`${SELECT_FOR_USER} WHERE d.id = $2`, [user?.id ?? NOBODY, id]);

/** The role a share link gives, if the request carries a valid one. */
async function linkRole(diagramId: string) {
  const token = currentShareLink();
  if (!token) return null;
  const link = await queryOne<{ role: MemberRole }>(
    `SELECT role FROM share_links
      WHERE diagram_id = $1 AND token = $2 AND (expires_at IS NULL OR expires_at > now())`,
    [diagramId, token],
  );
  return link?.role ?? null;
}

/**
 * The diagram and the caller's role on it; 404 without access. Signed-out
 * callers only get in with a share link (and only to view).
 */
export async function load(
  id: string,
  user: UserRow | null,
  { includeDeleted = false } = {},
): Promise<Access> {
  let row = await fetchForUser(id, user);
  if (row && user && !roleOf(row, user)) {
    // Opening a link from an invitation before anything else
    await claimInvites(user);
    row = await fetchForUser(id, user);
  }
  let role = row ? roleOf(row, user) : null;
  let via: Via = role === 'owner' ? 'owner' : 'member';
  let signInToEdit = false;

  const fromLink = row && role !== 'owner' ? await linkRole(id) : null;
  if (fromLink) {
    const linkGives: Role = fromLink === 'editor' && user ? 'editor' : 'viewer';
    signInToEdit = fromLink === 'editor' && !user;
    if (!role || RANK[linkGives] > RANK[role]) {
      role = linkGives;
      via = 'link';
    }
  }

  // No access looks the same as not existing, so ids can't be probed
  if (!row || !role || (row.deleted_at && !includeDeleted)) {
    throw notFound(currentShareLink() ? 'link_invalid' : 'diagram_not_found');
  }
  return { row, role, via, signInToEdit };
}

/**
 * The user's diagrams: their own and those shared with them. The trash
 * only has their own; shared diagrams in someone's trash aren't listed.
 */
export async function listDiagrams(
  user: UserRow,
  { trash = false, scope = 'all' }: { trash?: boolean; scope?: 'all' | 'owned' | 'shared' } = {},
) {
  await claimInvites(user);
  const owned = trash || scope === 'owned';
  const condition = owned
    ? 'd.owner_id = $1'
    : scope === 'shared'
      ? 'm.user_id IS NOT NULL'
      : '(d.owner_id = $1 OR m.user_id IS NOT NULL)';
  const rows = await query<DiagramWithOwner>(
    `${SELECT_FOR_USER}
      WHERE ${condition} AND (d.deleted_at IS NOT NULL) = $2
      ORDER BY ${trash ? 'd.deleted_at' : 'd.updated_at'} DESC`,
    [user.id, trash],
  );
  return rows.map((row) => summary(row, user));
}

export async function getDiagram(id: string, user: UserRow | null) {
  return full(await load(id, user));
}

export async function createDiagram(user: UserRow, id: string, input: DiagramInput) {
  const count = await queryOne<{ n: number }>(
    'SELECT count(*)::int AS n FROM diagrams WHERE owner_id = $1',
    [user.id],
  );
  if (count!.n >= config.limits.diagramsPerUser) {
    throw new HttpError(
      403,
      'diagram_limit_reached',
      `You can keep up to ${config.limits.diagramsPerUser} diagrams`,
    );
  }
  try {
    await query(
      `INSERT INTO diagrams (id, owner_id, updated_by, name, database, content, size_bytes)
       VALUES ($1, $2, $2, $3, $4, $5, $6)`,
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
  const { role } = await load(id, user);
  if (!canWrite(role)) throw forbidden('read_only');

  // Someone may be editing it live: their edits count as the latest version
  await flushRoom(id);
  const saved = await transaction(async (db) => {
    const {
      rows: [current],
    } = await db.query<{ version: number; updated_at: Date }>(
      'SELECT version, updated_at FROM diagrams WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
      [id],
    );
    if (!current) throw notFound('diagram_not_found');
    const stale = current.version !== baseVersion;
    if (stale && !force) {
      throw new HttpError(409, 'version_conflict', 'The diagram was changed elsewhere', {
        version: current.version,
        lastModified: current.updated_at,
      });
    }
    // Overwriting someone else's changes: keep them in the history
    if (stale) await keepCurrent(db, id, 'pre_overwrite');
    else await keepCurrentIfDue(db, id);

    const {
      rows: [updated],
    } = await db.query<{ version: number; updated_at: Date }>(
      `UPDATE diagrams
          SET name = $2, database = $3, content = $4, size_bytes = $5, updated_by = $6,
              version = version + 1, updated_at = now()
        WHERE id = $1
        RETURNING version, updated_at`,
      [id, input.name, input.database, input.content, sizeOf(input.content), user.id],
    );
    return { diagramId: id, version: updated.version, lastModified: updated.updated_at };
  });
  await reloadRoom(id);
  return saved;
}

export async function trashDiagram(id: string, user: UserRow) {
  const { role } = await load(id, user);
  if (role !== 'owner') throw forbidden('owner_only');
  await query('UPDATE diagrams SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL', [id]);
  // People who have it open lose access too
  await revalidateRoom(id);
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
  await query(`DELETE FROM diagrams WHERE deleted_at < now() - make_interval(days => $1)`, [
    config.limits.trashDays,
  ]);
}
