import { config } from '../config';
import { queryOne, transaction } from '../db';
import { hashPassword, verifyAgainstDummy, verifyPassword } from '../auth/crypto';
import { OAuthProfile } from '../auth/oauth';
import { endOtherSessions } from '../auth/session';
import { consumeToken, deleteTokens, sendPasswordResetEmail, sendVerificationEmail } from '../auth/tokens';
import { badRequest, conflict, forbidden, unauthorized } from '../utils/http-error';
import {
  createUser,
  findUserByEmail,
  findUserById,
  markEmailVerified,
  normalizeEmail,
  updateUser,
  UserRow,
} from './user-service';

export async function register(input: { email: string; password: string; name: string }) {
  if (!config.auth.registrationEnabled) throw forbidden('registration_disabled');
  if (await findUserByEmail(input.email)) throw conflict('email_taken', 'An account with this email already exists');

  let user: UserRow;
  try {
    user = await createUser(null, {
      email: input.email,
      name: input.name,
      passwordHash: await hashPassword(input.password),
    });
  } catch (e) {
    // Lost a race with another sign-up for the same email
    if ((e as { code?: string }).code === '23505') throw conflict('email_taken');
    throw e;
  }
  await sendVerificationEmail(user);
  return user;
}

export async function login(email: string, password: string) {
  const user = await findUserByEmail(email);
  if (!user || !user.password_hash) {
    await verifyAgainstDummy(password);
    throw unauthorized('invalid_credentials', 'Wrong email or password');
  }
  if (!(await verifyPassword(password, user.password_hash))) {
    throw unauthorized('invalid_credentials', 'Wrong email or password');
  }
  return user;
}

export async function changePassword(
  user: UserRow,
  currentPassword: string | undefined,
  newPassword: string,
  sessionId?: string,
) {
  // Accounts created through OAuth may set a first password without one
  if (user.password_hash) {
    if (!currentPassword || !(await verifyPassword(currentPassword, user.password_hash))) {
      throw badRequest('wrong_password', 'Current password is incorrect');
    }
  }
  await updateUser(user.id, { passwordHash: await hashPassword(newPassword) });
  await endOtherSessions(user.id, sessionId);
}

/** Always succeeds from the caller's view, so it can't probe for accounts. */
export async function requestPasswordReset(email: string) {
  const user = await findUserByEmail(email);
  if (user) await sendPasswordResetEmail(user);
}

export async function resetPassword(token: string, newPassword: string) {
  const userId = await consumeToken(token, 'reset_password');
  if (!userId) throw badRequest('invalid_token', 'This link is invalid or has expired');
  await updateUser(userId, { passwordHash: await hashPassword(newPassword) });
  // Receiving the email proves ownership of the address
  await markEmailVerified(userId);
  await endOtherSessions(userId);
  return (await findUserById(userId)) as UserRow;
}

export async function verifyEmail(token: string) {
  const userId = await consumeToken(token, 'verify_email');
  if (!userId) throw badRequest('invalid_token', 'This link is invalid or has expired');
  await markEmailVerified(userId);
}

export async function resendVerification(user: UserRow) {
  if (user.email_verified_at) return;
  await sendVerificationEmail(user);
}

/**
 * Finds or creates the account for an OAuth sign-in.
 * Links to an existing account with the same (provider-verified) email.
 * If that account never verified its email, someone else may have
 * registered it, so its password and sessions are dropped first.
 */
export async function signInWithOAuth(provider: string, profile: OAuthProfile) {
  const linked = await queryOne<UserRow>(
    `SELECT u.* FROM oauth_accounts o JOIN users u ON u.id = o.user_id
      WHERE o.provider = $1 AND o.provider_user_id = $2`,
    [provider, profile.providerUserId],
  );
  if (linked) return linked;

  if (!profile.email || !profile.emailVerified) {
    throw badRequest('oauth_email_unverified', 'Your account has no verified email address');
  }
  const email = normalizeEmail(profile.email);

  return transaction(async (db) => {
    const { rows } = await db.query<UserRow>('SELECT * FROM users WHERE email = $1 FOR UPDATE', [email]);
    let user = rows[0];
    if (user) {
      const other = await db.query('SELECT 1 FROM oauth_accounts WHERE user_id = $1 AND provider = $2', [
        user.id,
        provider,
      ]);
      if (other.rowCount) throw conflict('oauth_account_conflict', `Another ${provider} account is already linked`);
      if (!user.email_verified_at) {
        await db.query('DELETE FROM sessions WHERE user_id = $1', [user.id]);
        const updated = await db.query<UserRow>(
          `UPDATE users SET password_hash = NULL, email_verified_at = now(), updated_at = now()
            WHERE id = $1 RETURNING *`,
          [user.id],
        );
        user = updated.rows[0];
      }
    } else {
      user = await createUser(db, {
        email,
        name: profile.name || email.split('@')[0],
        avatarUrl: profile.avatarUrl,
        emailVerified: true,
      });
    }
    if (!user.avatar_url && profile.avatarUrl) {
      await db.query('UPDATE users SET avatar_url = $2 WHERE id = $1', [user.id, profile.avatarUrl]);
      user = { ...user, avatar_url: profile.avatarUrl };
    }
    await db.query(
      `INSERT INTO oauth_accounts (user_id, provider, provider_user_id, email) VALUES ($1, $2, $3, $4)`,
      [user.id, provider, profile.providerUserId, email],
    );
    await deleteTokens(user.id, 'verify_email');
    return user;
  });
}

/** Confirms identity before deleting an account. */
export async function confirmDeletion(user: UserRow, password: string | undefined, email: string | undefined) {
  if (user.password_hash) {
    if (!password || !(await verifyPassword(password, user.password_hash))) {
      throw badRequest('wrong_password', 'Password is incorrect');
    }
  } else if (!email || normalizeEmail(email) !== user.email) {
    throw badRequest('confirmation_mismatch', 'Type your email address to confirm');
  }
}
