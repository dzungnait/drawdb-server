import request from 'supertest';
import app from '../src/app';
import { migrate } from '../src/db/migrate';
import { query } from '../src/db';

export const ORIGIN = 'http://app.test';

let migrated: Promise<void> | null = null;
export const setupDb = () => (migrated ??= migrate(() => {}));

export async function resetData() {
  await query('TRUNCATE users, oauth_accounts, sessions, auth_tokens, diagrams, diagram_versions CASCADE');
}

/** A cookie-keeping client that sends the app's Origin like a browser. */
export function browser() {
  const agent = request.agent(app);
  const withOrigin = <T extends { set: (k: string, v: string) => T }>(r: T) => r.set('Origin', ORIGIN);
  return {
    agent,
    get: (url: string) => agent.get(url),
    post: (url: string, body?: object) => withOrigin(agent.post(url)).send(body ?? {}),
    patch: (url: string, body?: object) => withOrigin(agent.patch(url)).send(body ?? {}),
    delete: (url: string, body?: object) => withOrigin(agent.delete(url)).send(body ?? {}),
  };
}

export async function signUp(email = 'ada@example.com', password = 'correct horse', name = 'Ada') {
  const b = browser();
  const res = await b.post('/auth/register', { email, password, name });
  if (res.status !== 201) throw new Error(`sign up failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { b, user: res.body.user };
}

export { app, request };
