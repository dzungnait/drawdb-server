import { CookieOptions, Request, Response } from 'express';
import { config } from '../config';
import { query, queryOne } from '../db';
import { UserRow } from '../services/user-service';
import { hashToken, randomToken } from './crypto';

const DAY = 24 * 60 * 60 * 1000;
// Extend a session at most once per hour of activity
const TOUCH_INTERVAL = 60 * 60 * 1000;

function cookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: config.auth.cookieSecure,
    sameSite: config.auth.cookieSameSite,
    domain: config.auth.cookieDomain,
    path: '/',
  };
}

export async function startSession(req: Request, res: Response, userId: string) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + config.auth.sessionDays * DAY);
  await query(
    `INSERT INTO sessions (token_hash, user_id, user_agent, ip, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      hashToken(token),
      userId,
      req.get('user-agent')?.slice(0, 500) ?? null,
      req.ip ?? null,
      expiresAt,
    ],
  );
  res.cookie(config.auth.cookieName, token, { ...cookieOptions(), expires: expiresAt });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(config.auth.cookieName, cookieOptions());
}

interface SessionWithUser extends UserRow {
  session_id: string;
  session_last_seen_at: Date;
}

/** Resolves the session cookie to its user, sliding the expiry on use. */
export async function readSession(req: Request, res: Response) {
  const token = req.cookies?.[config.auth.cookieName];
  if (typeof token !== 'string' || !token) return null;

  const row = await queryOne<SessionWithUser>(
    `SELECT u.*, s.id AS session_id, s.last_seen_at AS session_last_seen_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)],
  );
  if (!row) {
    clearSessionCookie(res);
    return null;
  }

  if (Date.now() - new Date(row.session_last_seen_at).getTime() > TOUCH_INTERVAL) {
    const expiresAt = new Date(Date.now() + config.auth.sessionDays * DAY);
    await query('UPDATE sessions SET last_seen_at = now(), expires_at = $2 WHERE id = $1', [
      row.session_id,
      expiresAt,
    ]);
    res.cookie(config.auth.cookieName, token, { ...cookieOptions(), expires: expiresAt });
  }

  const { session_id: sessionId, session_last_seen_at: _lastSeen, ...user } = row;
  void _lastSeen;
  return { sessionId, user: user as UserRow };
}

export async function endSession(sessionId: string) {
  await query('DELETE FROM sessions WHERE id = $1', [sessionId]);
}

/** Signs the user out everywhere, optionally keeping the current session. */
export async function endOtherSessions(userId: string, keepSessionId?: string) {
  await query('DELETE FROM sessions WHERE user_id = $1 AND id IS DISTINCT FROM $2', [
    userId,
    keepSessionId ?? null,
  ]);
}

export async function purgeExpiredSessions() {
  await query('DELETE FROM sessions WHERE expires_at <= now()');
  await query(`DELETE FROM auth_tokens WHERE expires_at <= now() - interval '7 days'`);
}

/** The user behind a session token, for connections that aren't requests (sockets). */
export async function userForSessionToken(token: string) {
  return queryOne<UserRow>(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)],
  );
}
