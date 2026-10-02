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

/** The diagram's view and edit links (only the owner manages them). */
export async function listLinks(diagramId: string, user: UserRow) {
  await loadAsOwner(diagramId, user);
  const rows = await query<LinkRow>(
    'SELECT role, token, created_at, expires_at FROM share_links WHERE diagram_id = $1 ORDER BY role DESC',
    [diagramId],
  );
  return rows.map(toLink);
}

/**
 * Turns a link on, or changes when it expires. The token stays the same,
 * so links already handed out keep working.
 */
export async function setLink(
  diagramId: string,
  user: UserRow,
  role: MemberRole,
  expiresAt: Date | null,
) {
  await loadAsOwner(diagramId, user);
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
