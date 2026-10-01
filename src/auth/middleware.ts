import { NextFunction, Request, RequestHandler, Response } from 'express';
import { config } from '../config';
import { UserRow } from '../services/user-service';
import { forbidden, unauthorized } from '../utils/http-error';
import { readSession } from './session';

declare module 'express-serve-static-core' {
  interface Request {
    user?: UserRow;
    sessionId?: string;
  }
}

/** Express 4 doesn't forward rejected promises to the error handler. */
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

/** Attaches req.user when a valid session cookie is present. */
export const loadUser = asyncHandler(async (req, res, next) => {
  const session = await readSession(req, res);
  if (session) {
    req.user = session.user;
    req.sessionId = session.sessionId;
  }
  next();
});

/** Signed in, whether or not the email is verified. */
export const requireSignedIn: RequestHandler = (req, _res, next) => {
  next(req.user ? undefined : unauthorized('not_signed_in'));
};

/** Signed in, and verified when the server requires verification. */
export const requireUser: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(unauthorized('not_signed_in'));
  if (config.auth.requireEmailVerification && !req.user.email_verified_at) {
    return next(forbidden('email_not_verified'));
  }
  next();
};

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF protection for cookie-authenticated requests: anything that changes
 * state must come from an allowed origin. Browsers always send Origin on
 * cross-origin and same-origin non-GET fetches, so a missing Origin only
 * comes from non-browser clients, which don't carry the cookie implicitly.
 */
export const checkOrigin: RequestHandler = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();
  const origin = req.get('origin');
  if (!origin) return next();
  const allowed =
    config.dev ||
    config.server.allowedOrigins.includes(origin) ||
    origin === config.server.appUrl ||
    origin === new URL(config.server.publicApiUrl).origin;
  if (!allowed) return next(forbidden('bad_origin'));
  next();
};
