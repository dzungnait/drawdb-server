import { PoolClient } from 'pg';
import { query, queryOne } from '../db';

export interface UserRow {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  password_hash: string | null;
  email_verified_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** What the API exposes about a user to themselves. */
export interface PublicUser {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  emailVerified: boolean;
  hasPassword: boolean;
  providers: string[];
  createdAt: Date;
}

type Db = Pick<PoolClient, 'query'>;

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export async function findUserById(id: string) {
  return queryOne<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
}

export async function findUserByEmail(email: string) {
  return queryOne<UserRow>('SELECT * FROM users WHERE email = $1', [normalizeEmail(email)]);
}

export async function createUser(
  db: Db | null,
  input: {
    email: string;
    name: string;
    passwordHash?: string | null;
    avatarUrl?: string | null;
    emailVerified?: boolean;
  },
) {
  const sql = `
    INSERT INTO users (email, name, password_hash, avatar_url, email_verified_at)
    VALUES ($1, $2, $3, $4, CASE WHEN $5::boolean THEN now() END)
    RETURNING *`;
  const params = [
    normalizeEmail(input.email),
    input.name.trim(),
    input.passwordHash ?? null,
    input.avatarUrl ?? null,
    input.emailVerified ?? false,
  ];
  if (db) {
    const { rows } = await db.query<UserRow>(sql, params);
    return rows[0];
  }
  return (await queryOne<UserRow>(sql, params)) as UserRow;
}

export async function updateUser(
  id: string,
  fields: Partial<{ name: string; avatarUrl: string | null; passwordHash: string | null }>,
) {
  const sets: string[] = [];
  const params: unknown[] = [id];
  const add = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if (fields.name !== undefined) add('name', fields.name.trim());
  if (fields.avatarUrl !== undefined) add('avatar_url', fields.avatarUrl);
  if (fields.passwordHash !== undefined) add('password_hash', fields.passwordHash);
  if (sets.length === 0) return findUserById(id);
  return queryOne<UserRow>(
    `UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
    params,
  );
}

export async function markEmailVerified(id: string) {
  await query('UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1', [id]);
}

export async function deleteUser(id: string) {
  await query('DELETE FROM users WHERE id = $1', [id]);
}

export async function toPublicUser(user: UserRow): Promise<PublicUser> {
  const providers = await query<{ provider: string }>(
    'SELECT provider FROM oauth_accounts WHERE user_id = $1 ORDER BY provider',
    [user.id],
  );
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatar_url,
    emailVerified: Boolean(user.email_verified_at),
    hasPassword: Boolean(user.password_hash),
    providers: providers.map((p) => p.provider),
    createdAt: user.created_at,
  };
}
