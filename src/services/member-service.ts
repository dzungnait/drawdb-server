import { config } from '../config';
import { query, queryOne, transaction } from '../db';
import { escapeHtml, renderEmail } from '../utils/email-template';
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
  const name = diagram.name || 'Untitled diagram';
  const sender = from.name || from.email;
  sendTransactionalEmail(
    to,
    `${sender} shared "${name}" with you`,
    renderEmail({
      preview: `${sender} invited you to ${role === 'editor' ? 'edit' : 'view'} a diagram on drawDB.`,
      heading: `${sender} shared a diagram with you`,
      paragraphs: [
        `<b>${escapeHtml(sender)}</b> (${escapeHtml(from.email)}) invited you to ${
          role === 'editor' ? 'work on' : 'view'
        } a database diagram on drawDB.`,
      ],
      details: [
        ['Diagram', name],
        ['Your access', role === 'editor' ? 'Can edit' : 'Can view'],
        ['Shared by', `${sender} <${from.email}>`],
      ],
      action: {
        label: 'Open diagram',
        url: `${config.server.appUrl}/editor/diagrams/${diagram.id}`,
      },
      note: `Sign in, or create a free account, with ${to} to open it.`,
      reason: `You're receiving this email because ${sender} shared a diagram with ${to}.`,
    }),
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
  if (added!.is_new) sendShareEmail(email, user, { id: row.id, name: row.name }, role);
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

/**
 * Hands the diagram to someone who already has access. The previous owner
 * stays on as an editor; links and team shares are kept.
 */
export async function transferOwnership(diagramId: string, user: UserRow, memberId: string) {
  const { row } = await loadAsOwner(diagramId, user);
  const newOwner = await transaction(async (db) => {
    const {
      rows: [member],
    } = await db.query<PersonRow>(
      `DELETE FROM diagram_members m USING users u
        WHERE m.diagram_id = $1 AND m.user_id = $2 AND u.id = m.user_id
        RETURNING u.id, u.name, u.email, u.avatar_url`,
      [diagramId, memberId],
    );
    if (!member) throw notFound('member_not_found');
    const {
      rows: [owned],
    } = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM diagrams WHERE owner_id = $1',
      [memberId],
    );
    if (owned.n >= config.limits.diagramsPerUser) {
      throw new HttpError(
        403,
        'owner_limit_reached',
        `They already have ${config.limits.diagramsPerUser} diagrams`,
      );
    }
    // Still theirs to give (not handed over by a request at the same time)
    const moved = await db.query(
      'UPDATE diagrams SET owner_id = $2 WHERE id = $1 AND owner_id = $3',
      [diagramId, memberId, user.id],
    );
    if (!moved.rowCount) throw forbidden('owner_only');
    await db.query(
      `INSERT INTO diagram_members (diagram_id, user_id, role, invited_by)
       VALUES ($1, $2, 'editor', $3)
       ON CONFLICT (diagram_id, user_id) DO UPDATE SET role = 'editor'`,
      [diagramId, user.id, memberId],
    );
    return member;
  });
  await revalidateRoom(diagramId);
  const name = row.name || 'Untitled diagram';
  const sender = user.name || user.email;
  sendTransactionalEmail(
    newOwner.email,
    `${sender} made you the owner of "${name}"`,
    renderEmail({
      preview: `You now own "${name}" on drawDB.`,
      heading: 'You are now the owner of a diagram',
      paragraphs: [
        `<b>${escapeHtml(sender)}</b> handed over the ownership of <b>${escapeHtml(name)}</b> to you.`,
        `As the owner, you decide who can access it, manage its share links and can move it to the trash. ${escapeHtml(sender)} keeps access as an editor.`,
      ],
      details: [
        ['Diagram', name],
        ['Your access', 'Owner'],
        ['Previous owner', `${sender} <${user.email}>`],
      ],
      action: {
        label: 'Open diagram',
        url: `${config.server.appUrl}/editor/diagrams/${diagramId}`,
      },
      reason: `You're receiving this email because ${sender} transferred a diagram to you.`,
    }),
  );
  return listMembers(diagramId, user);
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
