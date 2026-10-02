import { config } from '../config';
import { query, queryOne } from '../db';
import { escapeHtml, layout } from '../auth/tokens';
import { badRequest, forbidden, HttpError, notFound } from '../utils/http-error';
import { sendTransactionalEmail } from '../utils/send-email';
import { revalidateRoom } from '../collab/rooms';
import { load, MemberRole } from './diagram-service';
import { teamsOfDiagram } from './team-service';
import { findUserByEmail, normalizeEmail, UserRow } from './user-service';

/** Members plus pending invitations, per diagram. */
const MAX_SHARES = 200;

interface PersonRow {
  id: string;
  name: string;
  email: string;
  avatar_url: string | null;
}

const person = (row: PersonRow) => ({
  id: row.id,
  name: row.name,
  email: row.email,
  avatarUrl: row.avatar_url,
});

async function loadAsOwner(diagramId: string, user: UserRow) {
  const access = await load(diagramId, user);
  if (access.role !== 'owner') throw forbidden('owner_only');
  return access;
}

/** Who has access. Pending invitations are only shown to the owner. */
export async function listMembers(diagramId: string, user: UserRow) {
  const { row, role, via } = await load(diagramId, user);
  // Someone with just the link doesn't get to see who else has access
  if (via === 'link') throw forbidden('members_only');
  const [owner, members, invites, teams] = await Promise.all([
    queryOne<PersonRow>('SELECT id, name, email, avatar_url FROM users WHERE id = $1', [
      row.owner_id,
    ]),
    query<PersonRow & { role: MemberRole; created_at: Date }>(
      `SELECT u.id, u.name, u.email, u.avatar_url, m.role, m.created_at
         FROM diagram_members m JOIN users u ON u.id = m.user_id
        WHERE m.diagram_id = $1
        ORDER BY m.created_at`,
      [diagramId],
    ),
    role === 'owner'
      ? query<{ id: string; email: string; role: MemberRole; created_at: Date }>(
          'SELECT id, email, role, created_at FROM diagram_invites WHERE diagram_id = $1 ORDER BY created_at',
          [diagramId],
        )
      : Promise.resolve([]),
    teamsOfDiagram(diagramId),
  ]);
  return {
    role,
    owner: person(owner!),
    teams,
    members: members.map((m) => ({ ...person(m), role: m.role, since: m.created_at })),
    invites: invites.map((i) => ({ id: i.id, email: i.email, role: i.role, since: i.created_at })),
  };
}

function sendShareEmail(
  to: string,
  from: UserRow,
  diagram: { id: string; name: string },
  role: MemberRole,
) {
  const link = `${config.server.appUrl}/editor/diagrams/${diagram.id}`;
  const name = diagram.name || 'Untitled diagram';
  return sendTransactionalEmail(
    to,
    `${from.name || from.email} shared "${name}" with you`,
    layout(
      'A diagram was shared with you',
      `<p>${escapeHtml(from.name || from.email)} (${escapeHtml(from.email)}) shared <b>${escapeHtml(name)}</b>
       with you as ${role === 'editor' ? 'an editor' : 'a viewer'}.</p>
       <p>Sign in (or create an account) with ${escapeHtml(to)} to open it.</p>`,
      link,
      'Open diagram',
    ),
  );
}

/**
 * Shares the diagram with an email. Someone with an account gets access
 * right away; otherwise the invitation waits until they sign up.
 * Sharing again with the same person changes their role.
 */
export async function shareDiagram(
  diagramId: string,
  user: UserRow,
  rawEmail: string,
  role: MemberRole,
) {
  const { row } = await loadAsOwner(diagramId, user);
  const email = normalizeEmail(rawEmail);
  if (email === user.email)
    throw badRequest('cannot_share_with_owner', 'You already own this diagram');

  const shares = await queryOne<{ n: number }>(
    `SELECT (SELECT count(*) FROM diagram_members WHERE diagram_id = $1)
          + (SELECT count(*) FROM diagram_invites WHERE diagram_id = $1) AS n`,
    [diagramId],
  );
  if (Number(shares!.n) >= MAX_SHARES) {
    throw new HttpError(
      403,
      'share_limit_reached',
      `A diagram can be shared with up to ${MAX_SHARES} people`,
    );
  }

  const target = await findUserByEmail(email);
  const added = target
    ? await queryOne<{ is_new: boolean }>(
        `INSERT INTO diagram_members (diagram_id, user_id, role, invited_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (diagram_id, user_id) DO UPDATE SET role = EXCLUDED.role
         RETURNING (xmax = 0) AS is_new`,
        [diagramId, target.id, role, user.id],
      )
    : await queryOne<{ is_new: boolean }>(
        `INSERT INTO diagram_invites (diagram_id, email, role, invited_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (diagram_id, email) DO UPDATE SET role = EXCLUDED.role
         RETURNING (xmax = 0) AS is_new`,
        [diagramId, email, role, user.id],
      );
  // Only the first time; a role change isn't worth an email
  if (added!.is_new) await sendShareEmail(email, user, { id: row.id, name: row.name }, role);
  else await revalidateRoom(diagramId);

  return { status: target ? 'added' : 'invited', ...(await listMembers(diagramId, user)) };
}

export async function changeRole(
  diagramId: string,
  user: UserRow,
  memberId: string,
  role: MemberRole,
) {
  await loadAsOwner(diagramId, user);
  const updated = await query(
    'UPDATE diagram_members SET role = $3 WHERE diagram_id = $1 AND user_id = $2 RETURNING 1',
    [diagramId, memberId, role],
  );
  if (!updated.length) throw notFound('member_not_found');
  // Applies right away to them if they have it open
  await revalidateRoom(diagramId);
  return listMembers(diagramId, user);
}

/** The owner removes someone, or a member leaves. */
export async function removeMember(diagramId: string, user: UserRow, memberId: string) {
  const { role } = await load(diagramId, user);
  if (role !== 'owner' && memberId !== user.id) throw forbidden('owner_only');
  const removed = await query(
    'DELETE FROM diagram_members WHERE diagram_id = $1 AND user_id = $2 RETURNING 1',
    [diagramId, memberId],
  );
  if (!removed.length) throw notFound('member_not_found');
  await revalidateRoom(diagramId);
}

export async function cancelInvite(diagramId: string, user: UserRow, inviteId: string) {
  await loadAsOwner(diagramId, user);
  const removed = await query(
    'DELETE FROM diagram_invites WHERE diagram_id = $1 AND id = $2 RETURNING 1',
    [diagramId, inviteId],
  );
  if (!removed.length) throw notFound('invite_not_found');
  return listMembers(diagramId, user);
}
