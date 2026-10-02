import rateLimit from 'express-rate-limit';
import { config } from '../config';

const options = (windowMinutes: number, limit: number) => ({
  windowMs: windowMinutes * 60 * 1000,
  limit,
  standardHeaders: 'draft-8' as const,
  legacyHeaders: false,
  skip: () => config.test || !config.limits.rateLimit,
  message: { error: { code: 'rate_limited', message: 'Too many requests, try again later' } },
});

// In-memory counters: per instance, reset on restart. Enough for one
// instance; several instances would need a shared store (e.g. Redis).

/** Everything under the API. */
export const apiLimiter = rateLimit(options(1, 300));

/** Sign-in, sign-up and anything that sends email. */
export const authLimiter = rateLimit(options(15, 20));

/** Sharing, which can send email to any address. */
export const shareLimiter = rateLimit(options(60, 60));
