import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app, browser, request, resetData, setupDb, signUp, ORIGIN } from './helpers';
import { closePool, query, queryOne } from '../src/db';
import { testOutbox } from '../src/utils/send-email';

const tokenFrom = (html: string) => /token=([A-Za-z0-9_-]+)/.exec(html)?.[1] ?? '';

beforeAll(setupDb);
beforeEach(async () => {
  await resetData();
  testOutbox.length = 0;
});
afterAll(closePool);

describe('providers', () => {
  it('reports password sign-in and only configured OAuth providers', async () => {
    const res = await request(app).get('/auth/providers');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ password: true, registration: true, oauth: ['google'] });
  });
});

describe('register and login', () => {
  it('registers, sets an httpOnly session cookie and returns the user', async () => {
    const b = browser();
    const res = await b.post('/auth/register', { email: '  Ada@Example.COM ', password: 'correct horse', name: 'Ada' });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({
      email: 'ada@example.com',
      name: 'Ada',
      emailVerified: false,
      hasPassword: true,
      providers: [],
    });
    expect(res.body.user.passwordHash).toBeUndefined();
    const cookie = res.headers['set-cookie'][0];
    expect(cookie).toMatch(/^drawdb_session=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);

    const me = await b.get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('ada@example.com');
  });

  it('stores only hashes of passwords and session tokens', async () => {
    const { b } = await signUp();
    const user = await queryOne<{ password_hash: string }>('SELECT password_hash FROM users');
    expect(user!.password_hash).toMatch(/^scrypt\$/);
    expect(user!.password_hash).not.toContain('correct horse');
    const cookie = (await b.post('/auth/login', { email: 'ada@example.com', password: 'correct horse' })).headers[
      'set-cookie'
    ][0];
    const raw = /drawdb_session=([^;]+)/.exec(cookie)![1];
    const sessions = await query<{ token_hash: string }>('SELECT token_hash FROM sessions');
    expect(sessions.some((s) => s.token_hash === raw)).toBe(false);
  });

  it('rejects a duplicate email regardless of case', async () => {
    await signUp('ada@example.com');
    const res = await browser().post('/auth/register', { email: 'ADA@example.com', password: 'another one', name: 'X' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('email_taken');
  });

  it('validates input', async () => {
    const res = await browser().post('/auth/register', { email: 'not-an-email', password: 'short', name: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_input');
    expect(res.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(['email', 'name', 'password']);
  });

  it('logs in with the right password only, with the same error for unknown emails', async () => {
    await signUp();
    const wrong = await browser().post('/auth/login', { email: 'ada@example.com', password: 'wrong password' });
    const unknown = await browser().post('/auth/login', { email: 'nobody@example.com', password: 'whatever1' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);

    const b = browser();
    const ok = await b.post('/auth/login', { email: 'ADA@example.com', password: 'correct horse' });
    expect(ok.status).toBe(200);
    expect((await b.get('/auth/me')).status).toBe(200);
  });

  it('logs out and invalidates the session server-side', async () => {
    const { b } = await signUp();
    const cookie = (await b.post('/auth/login', { email: 'ada@example.com', password: 'correct horse' })).headers[
      'set-cookie'
    ][0].split(';')[0];
    expect((await b.post('/auth/logout')).status).toBe(204);
    expect((await b.get('/auth/me')).status).toBe(401);
    // Replaying the old cookie no longer works
    const replay = await request(app).get('/auth/me').set('Cookie', cookie);
    expect(replay.status).toBe(401);
  });

  it('requires a session for /me', async () => {
    const res = await request(app).get('/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('not_signed_in');
  });
});

describe('CSRF protection', () => {
  it('rejects state-changing requests from other origins', async () => {
    const { b } = await signUp();
    const res = await b.agent.patch('/auth/me').set('Origin', 'https://evil.example').send({ name: 'Pwned' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('bad_origin');
    expect((await b.get('/auth/me')).body.user.name).toBe('Ada');
  });

  it('only sends CORS credentials to allowed origins', async () => {
    const ok = await request(app).options('/auth/me').set('Origin', ORIGIN).set('Access-Control-Request-Method', 'PATCH');
    expect(ok.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const evil = await request(app)
      .options('/auth/me')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'PATCH');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('profile and password', () => {
  it('updates the display name', async () => {
    const { b } = await signUp();
    const res = await b.patch('/auth/me', { name: '  Ada Lovelace ' });
    expect(res.status).toBe(200);
    expect(res.body.user.name).toBe('Ada Lovelace');
  });

  it('changes the password and signs out other sessions only', async () => {
    const { b } = await signUp();
    const other = browser();
    await other.post('/auth/login', { email: 'ada@example.com', password: 'correct horse' });

    const bad = await b.post('/auth/password', { currentPassword: 'nope nope', newPassword: 'battery staple' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('wrong_password');

    const ok = await b.post('/auth/password', { currentPassword: 'correct horse', newPassword: 'battery staple' });
    expect(ok.status).toBe(204);
    expect((await b.get('/auth/me')).status).toBe(200);
    expect((await other.get('/auth/me')).status).toBe(401);
    expect((await browser().post('/auth/login', { email: 'ada@example.com', password: 'battery staple' })).status).toBe(
      200,
    );
  });
});

describe('email verification', () => {
  it('sends a verification link on sign-up that verifies once', async () => {
    const { b } = await signUp();
    expect(testOutbox).toHaveLength(1);
    expect(testOutbox[0].to).toBe('ada@example.com');
    expect(testOutbox[0].html).toContain('http://app.test/verify-email?token=');
    const token = tokenFrom(testOutbox[0].html);

    expect((await browser().post('/auth/email/verify', { token })).status).toBe(204);
    expect((await b.get('/auth/me')).body.user.emailVerified).toBe(true);
    const again = await browser().post('/auth/email/verify', { token });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('invalid_token');
  });

  it('resending replaces the previous link', async () => {
    const { b } = await signUp();
    const first = tokenFrom(testOutbox[0].html);
    expect((await b.post('/auth/email/resend')).status).toBe(204);
    const second = tokenFrom(testOutbox[1].html);
    expect((await browser().post('/auth/email/verify', { token: first })).status).toBe(400);
    expect((await browser().post('/auth/email/verify', { token: second })).status).toBe(204);
  });
});

describe('password reset', () => {
  it('does not reveal whether an account exists', async () => {
    await signUp();
    testOutbox.length = 0;
    const known = await browser().post('/auth/password/forgot', { email: 'ada@example.com' });
    const unknown = await browser().post('/auth/password/forgot', { email: 'nobody@example.com' });
    expect(known.status).toBe(204);
    expect(unknown.status).toBe(204);
    expect(testOutbox.map((m) => m.to)).toEqual(['ada@example.com']);
  });

  it('resets with a valid link, signs in, ends other sessions, and burns the link', async () => {
    const { b: old } = await signUp();
    await browser().post('/auth/password/forgot', { email: 'ada@example.com' });
    const token = tokenFrom(testOutbox.at(-1)!.html);

    const fresh = browser();
    const res = await fresh.post('/auth/password/reset', { token, newPassword: 'brand new pass' });
    expect(res.status).toBe(200);
    expect(res.body.user.emailVerified).toBe(true);
    expect((await fresh.get('/auth/me')).status).toBe(200);
    expect((await old.get('/auth/me')).status).toBe(401);

    const reuse = await browser().post('/auth/password/reset', { token, newPassword: 'another pass' });
    expect(reuse.status).toBe(400);
    expect((await browser().post('/auth/login', { email: 'ada@example.com', password: 'brand new pass' })).status).toBe(
      200,
    );
  });

  it('rejects expired links', async () => {
    await signUp();
    await browser().post('/auth/password/forgot', { email: 'ada@example.com' });
    const token = tokenFrom(testOutbox.at(-1)!.html);
    await query(`UPDATE auth_tokens SET expires_at = now() - interval '1 minute'`);
    const res = await browser().post('/auth/password/reset', { token, newPassword: 'brand new pass' });
    expect(res.status).toBe(400);
  });
});

describe('account deletion', () => {
  it('requires the password, then deletes everything', async () => {
    const { b } = await signUp();
    expect((await b.delete('/auth/me', { password: 'wrong one' })).status).toBe(400);
    expect((await b.delete('/auth/me', { password: 'correct horse' })).status).toBe(204);
    expect((await b.get('/auth/me')).status).toBe(401);
    expect(await query('SELECT 1 FROM users')).toHaveLength(0);
    expect(await query('SELECT 1 FROM sessions')).toHaveLength(0);
  });
});

describe('session expiry', () => {
  it('rejects expired sessions', async () => {
    const { b } = await signUp();
    await query(`UPDATE sessions SET expires_at = now() - interval '1 second'`);
    expect((await b.get('/auth/me')).status).toBe(401);
  });
});

describe('OAuth', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Fakes Google's token and userinfo endpoints. */
  function fakeGoogle(profile: Record<string, unknown>) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.startsWith('https://oauth2.googleapis.com/token')) {
          return new Response(JSON.stringify({ access_token: 'at' }), { status: 200 });
        }
        if (url.startsWith('https://openidconnect.googleapis.com/v1/userinfo')) {
          return new Response(JSON.stringify(profile), { status: 200 });
        }
        return new Response('{}', { status: 404 });
      }),
    );
  }

  async function startFlow(b = browser(), returnTo = '/editor') {
    const start = await b.get(`/auth/oauth/google?returnTo=${encodeURIComponent(returnTo)}`);
    expect(start.status).toBe(302);
    const location = new URL(start.headers.location);
    expect(location.origin + location.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(location.searchParams.get('redirect_uri')).toBe('http://api.test/auth/oauth/google/callback');
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    return { b, state: location.searchParams.get('state')! };
  }

  it('is unavailable for providers without credentials', async () => {
    expect((await browser().get('/auth/oauth/github')).status).toBe(404);
  });

  it('creates a verified account and redirects back into the app', async () => {
    fakeGoogle({ sub: 'g-1', email: 'Grace@Example.com', email_verified: true, name: 'Grace', picture: 'http://p' });
    const { b, state } = await startFlow();
    const cb = await b.get(`/auth/oauth/google/callback?code=abc&state=${state}`);
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toBe('http://app.test/editor');
    const me = await b.get('/auth/me');
    expect(me.body.user).toMatchObject({
      email: 'grace@example.com',
      name: 'Grace',
      avatarUrl: 'http://p',
      emailVerified: true,
      hasPassword: false,
      providers: ['google'],
    });
  });

  it('rejects a callback whose state does not match', async () => {
    fakeGoogle({ sub: 'g-1', email: 'g@example.com', email_verified: true });
    const { b } = await startFlow();
    const cb = await b.get('/auth/oauth/google/callback?code=abc&state=forged');
    expect(cb.headers.location).toContain('auth_error=oauth_state_mismatch');
    expect((await b.get('/auth/me')).status).toBe(401);
  });

  it('never redirects outside the app', async () => {
    fakeGoogle({ sub: 'g-1', email: 'g@example.com', email_verified: true });
    const { b, state } = await startFlow(browser(), '//evil.example/x');
    const cb = await b.get(`/auth/oauth/google/callback?code=abc&state=${state}`);
    expect(cb.headers.location).toBe('http://app.test/');
  });

  it('links to a verified password account with the same email', async () => {
    const { b: owner } = await signUp('ada@example.com');
    await browser().post('/auth/email/verify', { token: tokenFrom(testOutbox[0].html) });
    fakeGoogle({ sub: 'g-ada', email: 'ada@example.com', email_verified: true, name: 'Ada G' });
    const { b, state } = await startFlow();
    await b.get(`/auth/oauth/google/callback?code=abc&state=${state}`);
    const me = (await b.get('/auth/me')).body.user;
    expect(me.providers).toEqual(['google']);
    expect(me.hasPassword).toBe(true);
    expect(me.name).toBe('Ada');
    expect((await owner.get('/auth/me')).status).toBe(200);
  });

  it('takes over an unverified account: drops its password and sessions', async () => {
    // Someone registered this address without owning it
    const { b: squatter } = await signUp('victim@example.com', 'squatter pass');
    fakeGoogle({ sub: 'g-victim', email: 'victim@example.com', email_verified: true, name: 'Victim' });
    const { b, state } = await startFlow();
    await b.get(`/auth/oauth/google/callback?code=abc&state=${state}`);
    const me = (await b.get('/auth/me')).body.user;
    expect(me).toMatchObject({ emailVerified: true, hasPassword: false });
    expect((await squatter.get('/auth/me')).status).toBe(401);
    expect(
      (await browser().post('/auth/login', { email: 'victim@example.com', password: 'squatter pass' })).status,
    ).toBe(401);
  });

  it('refuses accounts without a verified email', async () => {
    fakeGoogle({ sub: 'g-2', email: 'x@example.com', email_verified: false });
    const { b, state } = await startFlow();
    const cb = await b.get(`/auth/oauth/google/callback?code=abc&state=${state}`);
    expect(cb.headers.location).toContain('auth_error=oauth_email_unverified');
  });

  it('signs in again to the same account', async () => {
    fakeGoogle({ sub: 'g-3', email: 'same@example.com', email_verified: true });
    for (let i = 0; i < 2; i++) {
      const { b, state } = await startFlow();
      await b.get(`/auth/oauth/google/callback?code=abc&state=${state}`);
    }
    expect(await query('SELECT 1 FROM users')).toHaveLength(1);
    expect(await query('SELECT 1 FROM oauth_accounts')).toHaveLength(1);
  });

  it('deletes an OAuth-only account after typing the email', async () => {
    fakeGoogle({ sub: 'g-4', email: 'del@example.com', email_verified: true });
    const { b, state } = await startFlow();
    await b.get(`/auth/oauth/google/callback?code=abc&state=${state}`);
    expect((await b.delete('/auth/me', { email: 'other@example.com' })).status).toBe(400);
    expect((await b.delete('/auth/me', { email: 'DEL@example.com' })).status).toBe(204);
  });
});
