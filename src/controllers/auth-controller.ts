import { CookieOptions, Request, Response } from 'express';
import { z } from 'zod';
import { config, mailEnabled } from '../config';
import * as auth from '../services/auth-service';
import { deleteUser, toPublicUser, updateUser, UserRow } from '../services/user-service';
import { clearSessionCookie, endOtherSessions, endSession, startSession } from '../auth/session';
import {
  authorizationUrl,
  createAttempt,
  enabledProviders,
  exchangeCode,
  getProvider,
  safeReturnTo,
} from '../auth/oauth';
import { notFound } from '../utils/http-error';

const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(8, 'Use at least 8 characters').max(128);
const name = z.string().trim().min(1).max(100);
const token = z.string().min(10).max(200);

const sendUser = async (res: Response, user: UserRow, status = 200) =>
  res.status(status).json({ user: await toPublicUser(user) });

export async function providers(_req: Request, res: Response) {
  res.json({
    password: true,
    registration: config.auth.registrationEnabled,
    oauth: enabledProviders(),
    emailVerificationRequired: config.auth.requireEmailVerification,
    passwordReset: config.test || mailEnabled(),
  });
}

export async function me(req: Request, res: Response) {
  await sendUser(res, req.user!);
}

export async function register(req: Request, res: Response) {
  const body = z.object({ email, password, name }).parse(req.body);
  const user = await auth.register(body);
  await startSession(req, res, user.id);
  await sendUser(res, user, 201);
}

export async function login(req: Request, res: Response) {
  const body = z.object({ email, password: z.string().min(1).max(128) }).parse(req.body);
  const user = await auth.login(body.email, body.password);
  await startSession(req, res, user.id);
  await sendUser(res, user);
}

export async function logout(req: Request, res: Response) {
  if (req.sessionId) await endSession(req.sessionId);
  clearSessionCookie(res);
  res.status(204).end();
}

export async function logoutOthers(req: Request, res: Response) {
  await endOtherSessions(req.user!.id, req.sessionId);
  res.status(204).end();
}

export async function updateProfile(req: Request, res: Response) {
  const body = z.object({ name }).parse(req.body);
  const user = await updateUser(req.user!.id, body);
  await sendUser(res, user!);
}

export async function changePassword(req: Request, res: Response) {
  const body = z.object({ currentPassword: z.string().max(128).optional(), newPassword: password }).parse(req.body);
  await auth.changePassword(req.user!, body.currentPassword, body.newPassword, req.sessionId);
  res.status(204).end();
}

export async function forgotPassword(req: Request, res: Response) {
  const body = z.object({ email }).parse(req.body);
  await auth.requestPasswordReset(body.email);
  res.status(204).end();
}

export async function resetPassword(req: Request, res: Response) {
  const body = z.object({ token, newPassword: password }).parse(req.body);
  const user = await auth.resetPassword(body.token, body.newPassword);
  await startSession(req, res, user.id);
  await sendUser(res, user);
}

export async function verifyEmail(req: Request, res: Response) {
  const body = z.object({ token }).parse(req.body);
  await auth.verifyEmail(body.token);
  res.status(204).end();
}

export async function resendVerification(req: Request, res: Response) {
  await auth.resendVerification(req.user!);
  res.status(204).end();
}

export async function deleteAccount(req: Request, res: Response) {
  const body = z
    .object({ password: z.string().max(128).optional(), email: z.string().max(254).optional() })
    .parse(req.body ?? {});
  await auth.confirmDeletion(req.user!, body.password, body.email);
  await deleteUser(req.user!.id);
  clearSessionCookie(res);
  res.status(204).end();
}

// ---- OAuth

const ATTEMPT_COOKIE = 'drawdb_oauth';
const attemptCookie = (): CookieOptions => ({
  httpOnly: true,
  secure: config.auth.cookieSecure,
  // The provider redirects back with a top-level GET, which Lax allows
  sameSite: 'lax',
  // Matches the browser-visible path, also behind a prefix like /api
  path: `${new URL(config.server.publicApiUrl).pathname.replace(/\/+$/, '')}/auth/oauth`,
  maxAge: 10 * 60 * 1000,
});

const appRedirect = (path: string, error?: string) => {
  const url = new URL(path, config.server.appUrl);
  if (error) url.searchParams.set('auth_error', error);
  return url.toString();
};

export async function oauthStart(req: Request, res: Response) {
  const provider = getProvider(req.params.provider);
  if (!provider) throw notFound('provider_not_enabled');
  const attempt = createAttempt(safeReturnTo(req.query.returnTo));
  res.cookie(
    ATTEMPT_COOKIE,
    JSON.stringify({ provider: req.params.provider, ...attempt, challenge: undefined }),
    attemptCookie(),
  );
  res.redirect(authorizationUrl(req.params.provider, provider, attempt.state, attempt.challenge));
}

export async function oauthCallback(req: Request, res: Response) {
  const id = req.params.provider;
  const provider = getProvider(id);
  if (!provider) throw notFound('provider_not_enabled');

  let attempt: { provider?: string; state?: string; verifier?: string; returnTo?: string } = {};
  try {
    attempt = JSON.parse(req.cookies?.[ATTEMPT_COOKIE] ?? '{}');
  } catch {
    // treated as a missing attempt below
  }
  res.clearCookie(ATTEMPT_COOKIE, { ...attemptCookie(), maxAge: undefined });
  const returnTo = safeReturnTo(attempt.returnTo);

  if (typeof req.query.error === 'string') return res.redirect(appRedirect(returnTo, 'oauth_cancelled'));
  if (
    attempt.provider !== id ||
    !attempt.state ||
    !attempt.verifier ||
    attempt.state !== req.query.state ||
    typeof req.query.code !== 'string'
  ) {
    return res.redirect(appRedirect(returnTo, 'oauth_state_mismatch'));
  }

  try {
    const accessToken = await exchangeCode(id, provider, req.query.code, attempt.verifier);
    const profile = await provider.fetchProfile(accessToken);
    const user = await auth.signInWithOAuth(id, profile);
    await startSession(req, res, user.id);
    res.redirect(appRedirect(returnTo));
  } catch (e) {
    const code = (e as { code?: string }).code;
    console.error(`OAuth sign-in with ${id} failed:`, e);
    res.redirect(appRedirect(returnTo, typeof code === 'string' && code ? code : 'oauth_failed'));
  }
}
