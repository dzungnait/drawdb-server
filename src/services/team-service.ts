import { config } from '../config';
import { query, queryOne, transaction } from '../db';
import { escapeHtml, layout } from '../auth/tokens';
import { revalidateRoom } from '../collab/rooms';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../utils/http-error';
import { sendTransactionalEmail } from '../utils/send-email';
import { claimInvites, load, MemberRole } from './diagram-service';
import { findUserByEmail, normalizeEmail, UserRow } from './user-service';

export type TeamRole = 'admin' | 'member';

const MAX_TEAMS_PER_USER = 50;
/** Members plus pending invitations. */
const MAX_TEAM_SIZE = 500;

interface TeamRow {
  id: string;
  name: string;
  created_at: Date;
  role: TeamRole;
  member_count: number;
}

const team = (row: TeamRow) => ({
  id: row.id,
  name: row.name,
  role: row.role,
  memberCount: row.member_count,
  createdAt: row.created_at,
});

const SELECT_MY_TEAMS = `
  SELECT t.id, t.name, t.created_at, me.role,
         (SELECT count(*)::int FROM team_members x WHERE x.team_id = t.id) AS member_count
    FROM teams t JOIN team_members me ON me.team_id = t.id AND me.user_id = $1`;

/** The team and the caller's role in it; 404 for non-members. */
async function loadTeam(id: string, user: UserRow) {
  const row = await queryOne<TeamRow>(`${SELECT_MY_TEAMS} WHERE t.id = $2`, [user.id, id]);
  if (!row) throw notFound('team_not_found');
  return row;
}

async function loadAsAdmin(id: string, user: UserRow) {
  const row = await loadTeam(id, user);
  if (row.role !== 'admin') throw forbidden('team_admin_only');
  return row;
}

/** Everyone in a team who may have its diagrams open gets re-checked. */
async function revalidateTeamDiagrams(teamId: string) {
  const rows = await query<{ diagram_id: string }>(
    'SELECT diagram_id FROM diagram_team_shares WHERE team_id = $1',
    [teamId],
  );
  await Promise.all(rows.map((r) => revalidateRoom(r.diagram_id)));
}

// ---- teams

export async function listTeams(user: UserRow) {
  await claimInvites(user);
  const rows = await query<TeamRow>(`${SELECT_MY_TEAMS} ORDER BY lower(t.name)`, [user.id]);
  return rows.map(team);
}

export async function createTeam(user: UserRow, name: string) {
  const count = await queryOne<{ n: number }>(
    'SELECT count(*)::int AS n FROM team_members WHERE user_id = $1',
    [user.id],
  );
  if (count!.n >= MAX_TEAMS_PER_USER) {
    throw new HttpError(
      403,
      'team_limit_reached',
      `You can be in up to ${MAX_TEAMS_PER_USER} teams`,
    );
  }
  const id = await transaction(async (db) => {
    const {
      rows: [row],
    } = await db.query<{ id: string }>(
      'INSERT INTO teams (name, created_by) VALUES ($1, $2) RETURNING id',
      [name, user.id],
    );
    await db.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'admin')`, [
      row.id,
      user.id,
    ]);
    return row.id;
  });
  return getTeam(id, user);
}

export async function renameTeam(id: string, user: UserRow, name: string) {
  await loadAsAdmin(id, user);
  await query('UPDATE teams SET name = $2 WHERE id = $1', [id, name]);
  return getTeam(id, user);
}

export async function deleteTeam(id: string, user: UserRow) {
  await loadAsAdmin(id, user);
  const shared = await query<{ diagram_id: string }>(
    'SELECT diagram_id FROM diagram_team_shares WHERE team_id = $1',
    [id],
  );
  await query('DELETE FROM teams WHERE id = $1', [id]);
  await Promise.all(shared.map((r) => revalidateRoom(r.diagram_id)));
}

/** The team with its members; pending invitations only for admins. */
export async function getTeam(id: string, user: UserRow) {
  const row = await loadTeam(id, user);
  const [members, invites] = await Promise.all([
    query<{ id: string; name: string; email: string; avatar_url: string | null; role: TeamRole }>(
      `SELECT u.id, u.name, u.email, u.avatar_url, m.role
         FROM team_members m JOIN users u ON u.id = m.user_id
        WHERE m.team_id = $1
        ORDER BY m.role, lower(u.name)`,
      [id],
    ),
    row.role === 'admin'
      ? query<{ id: string; email: string; role: TeamRole; created_at: Date }>(
          'SELECT id, email, role, created_at FROM team_invites WHERE team_id = $1 ORDER BY created_at',
          [id],
        )
      : Promise.resolve([]),
  ]);
  return {
    ...team(row),
    members: members.map((m) => ({
      id: m.id,
      name: m.name,
      email: m.email,
      avatarUrl: m.avatar_url,
      role: m.role,
    })),
    invites: invites.map((i) => ({ id: i.id, email: i.email, role: i.role, since: i.created_at })),
  };
}

// ---- members

function sendTeamInvite(to: string, from: UserRow, teamName: string) {
  return sendTransactionalEmail(
    to,
    `${from.name || from.email} added you to the team "${teamName}"`,
    layout(
      `You're in ${escapeHtml(teamName)}`,
      `<p>${escapeHtml(from.name || from.email)} added you to the team <b>${escapeHtml(teamName)}</b>
       on drawDB. Diagrams shared with the team show up in your list.</p>
       <p>Sign in (or create an account) with ${escapeHtml(to)} to see them.</p>`,
      `${config.server.appUrl}/`,
      'Open drawDB',
    ),
  );
}

/** Adds someone by email; without an account, the invitation waits. */
export async function addMember(id: string, user: UserRow, rawEmail: string, role: TeamRole) {
  const row = await loadAsAdmin(id, user);
  const email = normalizeEmail(rawEmail);
  const size = await queryOne<{ n: string }>(
    `SELECT (SELECT count(*) FROM team_members WHERE team_id = $1)
          + (SELECT count(*) FROM team_invites WHERE team_id = $1) AS n`,
    [id],
  );
  if (Number(size!.n) >= MAX_TEAM_SIZE) {
    throw new HttpError(403, 'team_full', `A team can have up to ${MAX_TEAM_SIZE} members`);
  }
  const target = await findUserByEmail(email);
  if (target) {
    const added = await queryOne(
      `INSERT INTO team_members (team_id, user_id, role, invited_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (team_id, user_id) DO NOTHING RETURNING 1`,
      [id, target.id, role, user.id],
    );
    if (!added) throw conflict('already_in_team', 'Already in the team');
  } else {
    await query(
      `INSERT INTO team_invites (team_id, email, role, invited_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (team_id, email) DO UPDATE SET role = EXCLUDED.role`,
      [id, email, role, user.id],
    );
  }
  await sendTeamInvite(email, user, row.name);
  return { status: target ? 'added' : 'invited', ...(await getTeam(id, user)) };
}

/** A team always keeps at least one admin. */
async function assertAnotherAdmin(teamId: string, leavingUserId: string) {
  const others = await queryOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM team_members
      WHERE team_id = $1 AND role = 'admin' AND user_id <> $2`,
    [teamId, leavingUserId],
  );
  if (others!.n === 0) {
    throw badRequest('last_admin', 'Make someone else an admin first, or delete the team');
  }
}

export async function changeMemberRole(
  id: string,
  user: UserRow,
  memberId: string,
  role: TeamRole,
) {
  await loadAsAdmin(id, user);
  if (role === 'member') await assertAnotherAdmin(id, memberId);
  const updated = await query(
    'UPDATE team_members SET role = $3 WHERE team_id = $1 AND user_id = $2 RETURNING 1',
    [id, memberId, role],
  );
  if (!updated.length) throw notFound('member_not_found');
  return getTeam(id, user);
}

/** An admin removes someone, or a member leaves. */
export async function removeMember(id: string, user: UserRow, memberId: string) {
  const row = await loadTeam(id, user);
  if (row.role !== 'admin' && memberId !== user.id) throw forbidden('team_admin_only');
  await assertAnotherAdmin(id, memberId);
  const removed = await query(
    'DELETE FROM team_members WHERE team_id = $1 AND user_id = $2 RETURNING 1',
    [id, memberId],
  );
  if (!removed.length) throw notFound('member_not_found');
  // They may have the team's diagrams open
  await revalidateTeamDiagrams(id);
}

export async function cancelInvite(id: string, user: UserRow, inviteId: string) {
  await loadAsAdmin(id, user);
  const removed = await query(
    'DELETE FROM team_invites WHERE team_id = $1 AND id = $2 RETURNING 1',
    [id, inviteId],
  );
  if (!removed.length) throw notFound('invite_not_found');
  return getTeam(id, user);
}

// ---- diagrams shared with teams

/** Teams a diagram is shared with, for anyone who can see who has access. */
export async function teamsOfDiagram(diagramId: string) {
  const rows = await query<{ id: string; name: string; role: MemberRole; member_count: number }>(
    `SELECT t.id, t.name, s.role,
            (SELECT count(*)::int FROM team_members x WHERE x.team_id = t.id) AS member_count
       FROM diagram_team_shares s JOIN teams t ON t.id = s.team_id
      WHERE s.diagram_id = $1
      ORDER BY lower(t.name)`,
    [diagramId],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, role: r.role, memberCount: r.member_count }));
}

async function loadDiagramAsOwner(diagramId: string, user: UserRow) {
  const access = await load(diagramId, user);
  if (access.role !== 'owner') throw forbidden('owner_only');
}

/** Shares with a team the owner belongs to; again changes the role. */
export async function shareWithTeam(
  diagramId: string,
  user: UserRow,
  teamId: string,
  role: MemberRole,
) {
  await loadDiagramAsOwner(diagramId, user);
  await loadTeam(teamId, user);
  await query(
    `INSERT INTO diagram_team_shares (diagram_id, team_id, role, shared_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (diagram_id, team_id) DO UPDATE SET role = EXCLUDED.role`,
    [diagramId, teamId, role, user.id],
  );
  await revalidateRoom(diagramId);
}

export async function unshareWithTeam(diagramId: string, user: UserRow, teamId: string) {
  await loadDiagramAsOwner(diagramId, user);
  const removed = await query(
    'DELETE FROM diagram_team_shares WHERE diagram_id = $1 AND team_id = $2 RETURNING 1',
    [diagramId, teamId],
  );
  if (!removed.length) throw notFound('team_not_found');
  await revalidateRoom(diagramId);
}
