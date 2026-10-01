import { config } from '../config';
import { query, queryOne, transaction } from '../db';
import { sendTransactionalEmail } from '../utils/send-email';
import { UserRow } from '../services/user-service';
import { hashToken, randomToken } from './crypto';

type Purpose = 'verify_email' | 'reset_password';

const LIFETIME_MINUTES: Record<Purpose, number> = {
  verify_email: 24 * 60,
  reset_password: 60,
};

async function issueToken(userId: string, purpose: Purpose) {
  const token = randomToken();
  // A new link invalidates the previous ones of the same kind
  await transaction(async (db) => {
    await db.query('DELETE FROM auth_tokens WHERE user_id = $1 AND purpose = $2', [userId, purpose]);
    await db.query(
      `INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(mins => $4))`,
      [userId, purpose, hashToken(token), LIFETIME_MINUTES[purpose]],
    );
  });
  return token;
}

/** Marks a token used and returns its user id, or null if invalid/expired. */
export async function consumeToken(token: string, purpose: Purpose) {
  const row = await queryOne<{ user_id: string }>(
    `UPDATE auth_tokens SET used_at = now()
      WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
      RETURNING user_id`,
    [hashToken(token), purpose],
  );
  return row?.user_id ?? null;
}

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const layout = (title: string, body: string, link: string, action: string) => `
<html><body style="font-family:sans-serif;color:#222;max-width:520px;margin:auto">
  <h2>${title}</h2>
  ${body}
  <p><a href="${link}" style="display:inline-block;padding:10px 18px;background:#175e7a;color:#fff;border-radius:6px;text-decoration:none">${action}</a></p>
  <p style="color:#777;font-size:13px">Or paste this link into your browser:<br>${link}</p>
</body></html>`;

export async function sendVerificationEmail(user: UserRow) {
  const token = await issueToken(user.id, 'verify_email');
  const link = `${config.server.appUrl}/verify-email?token=${token}`;
  return sendTransactionalEmail(
    user.email,
    'Verify your drawDB email',
    layout(
      'Confirm your email',
      `<p>Hi ${escapeHtml(user.name || user.email)}, confirm this address to finish setting up your account.</p>`,
      link,
      'Verify email',
    ),
  );
}

export async function sendPasswordResetEmail(user: UserRow) {
  const token = await issueToken(user.id, 'reset_password');
  const link = `${config.server.appUrl}/reset-password?token=${token}`;
  return sendTransactionalEmail(
    user.email,
    'Reset your drawDB password',
    layout(
      'Reset your password',
      `<p>Someone asked to reset the password for ${escapeHtml(user.email)}. If it wasn't you, ignore this email. The link expires in an hour.</p>`,
      link,
      'Choose a new password',
    ),
  );
}

export async function deleteTokens(userId: string, purpose: Purpose) {
  await query('DELETE FROM auth_tokens WHERE user_id = $1 AND purpose = $2', [userId, purpose]);
}
