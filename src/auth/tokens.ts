import { config } from '../config';
import { query, queryOne, transaction } from '../db';
import { sendTransactionalEmail } from '../utils/send-email';
import { escapeHtml, renderEmail } from '../utils/email-template';
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
    await db.query('DELETE FROM auth_tokens WHERE user_id = $1 AND purpose = $2', [
      userId,
      purpose,
    ]);
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

export async function sendVerificationEmail(user: UserRow) {
  const token = await issueToken(user.id, 'verify_email');
  const link = `${config.server.appUrl}/verify-email?token=${token}`;
  sendTransactionalEmail(
    user.email,
    'Confirm your email address for drawDB',
    renderEmail({
      preview: 'One click to finish setting up your drawDB account.',
      heading: 'Confirm your email address',
      paragraphs: [
        `Hi ${escapeHtml(user.name || user.email)},`,
        `Thanks for signing up for drawDB. Please confirm that <b>${escapeHtml(user.email)}</b> is your email address, so we can reach you about diagrams shared with you and help you get back into your account.`,
      ],
      action: { label: 'Confirm email address', url: link },
      note: 'This link expires in 24 hours.',
      reason:
        "You're receiving this email because an account was created with this address. If it wasn't you, you can ignore it.",
    }),
  );
}

export async function sendPasswordResetEmail(user: UserRow) {
  const token = await issueToken(user.id, 'reset_password');
  const link = `${config.server.appUrl}/reset-password?token=${token}`;
  sendTransactionalEmail(
    user.email,
    'Reset your drawDB password',
    renderEmail({
      preview: 'Use this link to choose a new password. It expires in one hour.',
      heading: 'Reset your password',
      paragraphs: [
        `Hi ${escapeHtml(user.name || user.email)},`,
        `We received a request to reset the password for the drawDB account <b>${escapeHtml(user.email)}</b>. Click the button below to choose a new one.`,
        "If you didn't ask for this, you can safely ignore this email: your password stays the same.",
      ],
      action: { label: 'Choose a new password', url: link },
      note: 'For your security, this link expires in 1 hour and can be used only once.',
      reason:
        "You're receiving this email because a password reset was requested for your drawDB account.",
    }),
  );
}

export async function deleteTokens(userId: string, purpose: Purpose) {
  await query('DELETE FROM auth_tokens WHERE user_id = $1 AND purpose = $2', [userId, purpose]);
}
