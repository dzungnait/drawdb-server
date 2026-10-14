import { randomBytes } from 'crypto';
import { query, queryOne } from '../db';
import { badRequest, forbidden, notFound } from '../utils/http-error';
import { revalidateRoom } from '../collab/rooms';
import { load, MemberRole } from './diagram-service';
import { UserRow } from './user-service';

interface LinkRow {
  role: MemberRole;
  token: string;
  created_at: Date;
  expires_at: Date | null;
}

const newToken = () => randomBytes(24).toString('base64url');

const toLink = (row: LinkRow) => ({
  role: row.role,
  token: row.token,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  expired: Boolean(row.expires_at && row.expires_at <= new Date()),
});

async function loadAsOwner(diagramId: string, user: UserRow) {
  const access = await load(diagramId, user);
  if (access.role !== 'owner') throw forbidden('owner_only');
}

/**
 * The owner manages both links. An editor it's shared with may only turn
 * the view link on and copy it; they don't see the edit link. Someone who is
 * an editor only through the edit link can't make links.
 */
async function loadForLinks(diagramId: string, user: UserRow) {
  const { role, via } = await load(diagramId, user);
  if (role === 'owner') return 'owner';
  if (role === 'editor' && via === 'member') return 'editor';
  throw forbidden('owner_only');
}

/** The diagram's links the caller may see. */
export async function listLinks(diagramId: string, user: UserRow) {
  const as = await loadForLinks(diagramId, user);
  const rows = await query<LinkRow>(
    `SELECT role, token, created_at, expires_at FROM share_links
      WHERE diagram_id = $1 AND ($2 OR role = 'viewer') ORDER BY role DESC`,
    [diagramId, as === 'owner'],
  );
  return rows.map(toLink);
}

/**
 * Turns a link on, or changes when it expires. The token stays the same,
 * so links already handed out keep working. Editors can only turn the view
 * link on, without an expiry; one that's already on stays as the owner set it.
 */
export async function setLink(
  diagramId: string,
  user: UserRow,
  role: MemberRole,
  expiresAt: Date | null,
) {
  const as = await loadForLinks(diagramId, user);
  if (as === 'editor') {
    if (role !== 'viewer' || expiresAt) throw forbidden('owner_only');
    await query(
      `INSERT INTO share_links (diagram_id, role, token, created_by) VALUES ($1, 'viewer', $2, $3)
       ON CONFLICT (diagram_id, role) DO NOTHING`,
      [diagramId, newToken(), user.id],
    );
    return listLinks(diagramId, user);
  }
  if (expiresAt && expiresAt <= new Date())
    throw badRequest('expiry_in_past', 'Pick a time in the future');
  await query(
    `INSERT INTO share_links (diagram_id, role, token, created_by, expires_at) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (diagram_id, role) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
    [diagramId, role, newToken(), user.id, expiresAt],
  );
  // People in it through this link may have lost access
  await revalidateRoom(diagramId);
  return listLinks(diagramId, user);
}

/** A new token: whoever has the old link loses access through it. */
export async function regenerateLink(diagramId: string, user: UserRow, role: MemberRole) {
  await loadAsOwner(diagramId, user);
  const updated = await queryOne(
    `UPDATE share_links SET token = $3, created_by = $4, created_at = now()
      WHERE diagram_id = $1 AND role = $2 RETURNING 1`,
    [diagramId, role, newToken(), user.id],
  );
  if (!updated) throw notFound('link_not_found');
  // People in it through this link may have lost access
  await revalidateRoom(diagramId);
  return listLinks(diagramId, user);
}

export async function deleteLink(diagramId: string, user: UserRow, role: MemberRole) {
  await loadAsOwner(diagramId, user);
  await query('DELETE FROM share_links WHERE diagram_id = $1 AND role = $2', [diagramId, role]);
  // People in it through this link may have lost access
  await revalidateRoom(diagramId);
  return listLinks(diagramId, user);
}

/** Expired links do nothing; drop them after a while. */
export async function purgeExpiredLinks() {
  await query(`DELETE FROM share_links WHERE expires_at < now() - interval '30 days'`);
}
