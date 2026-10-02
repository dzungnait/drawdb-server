import { config as dotenvConfig } from 'dotenv';

dotenvConfig();

const env = process.env;

const list = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);

const bool = (value: string | undefined, fallback: boolean) =>
  value === undefined || value === '' ? fallback : value === 'true';

const trimSlash = (url: string) => url.replace(/\/+$/, '');

const dev = env.NODE_ENV === 'dev';
const allowedOrigins = list(env.CLIENT_URLS);

// Where the frontend lives: used for links in emails and OAuth redirects
const appUrl = trimSlash(env.APP_URL || allowedOrigins[0] || 'http://localhost:5173');
// Public URL of this API as browsers reach it (directly, or through the
// frontend's /api proxy). OAuth providers redirect back here.
const publicApiUrl = trimSlash(env.PUBLIC_API_URL || `http://localhost:${env.PORT || 5000}`);

type SameSite = 'lax' | 'strict' | 'none';
const sameSite = (['lax', 'strict', 'none'].includes(env.COOKIE_SAMESITE ?? '')
  ? env.COOKIE_SAMESITE
  : 'lax') as SameSite;

const oauthProvider = (id: string, secret: string) =>
  env[id] && env[secret] ? { clientId: env[id] as string, clientSecret: env[secret] as string } : null;

export const config = {
  dev,
  test: env.NODE_ENV === 'test',
  api: {
    github: env.GITHUB_TOKEN,
  },
  server: {
    port: env.PORT || 5000,
    allowedOrigins,
    // Number of reverse proxies in front of the app (Railway, nginx...).
    // Needed for correct client IPs (rate limits) and secure cookies.
    trustProxy: Number(env.TRUST_PROXY ?? (dev ? 0 : 1)),
    appUrl,
    publicApiUrl,
  },
  database: {
    url: env.DATABASE_URL || '',
    ssl: bool(env.DATABASE_SSL, false),
  },
  auth: {
    cookieName: env.SESSION_COOKIE_NAME || 'drawdb_session',
    // "none" is required when the frontend and the API are on different
    // sites (e.g. two *.up.railway.app domains); it implies Secure.
    cookieSameSite: sameSite,
    cookieSecure: bool(env.COOKIE_SECURE, sameSite === 'none' || !dev),
    cookieDomain: env.COOKIE_DOMAIN || undefined,
    sessionDays: Number(env.SESSION_DAYS || 30),
    registrationEnabled: bool(env.AUTH_REGISTRATION_ENABLED, true),
    requireEmailVerification: bool(env.AUTH_REQUIRE_EMAIL_VERIFICATION, false),
    oauth: {
      google: oauthProvider('GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'),
      github: oauthProvider('GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'),
    },
  },
  limits: {
    // Includes diagrams in the trash
    diagramsPerUser: Number(env.MAX_DIAGRAMS_PER_USER || 1000),
    // Request body limit, which bounds the size of one diagram
    bodySize: env.MAX_BODY_SIZE || '5mb',
    trashDays: Number(env.TRASH_DAYS || 30),
    // Off only for automated browser tests, which sign up many accounts
    rateLimit: bool(env.RATE_LIMIT, true),
  },
  versions: {
    // While editing, the state before an edit is kept at most this often
    intervalMinutes: Number(env.VERSION_INTERVAL_MINUTES || 10),
    // Unnamed versions older than this are deleted (0 keeps them forever).
    // Before that they are thinned out: all from the last day, then one
    // per hour for a week, then one per day.
    retentionDays: Number(env.VERSION_RETENTION_DAYS ?? 90),
  },
  mail: {
    // Any SMTP server; without it, a well-known service (Gmail...)
    host: env.MAIL_HOST || '',
    port: Number(env.MAIL_PORT || 587),
    // TLS from the start (port 465); otherwise STARTTLS when offered
    secure: bool(env.MAIL_SECURE, env.MAIL_PORT === '465'),
    service: env.MAIL_SERVICE || 'gmail',
    username: env.MAIL_USERNAME || '',
    password: env.MAIL_PASSWORD || '',
    from: env.MAIL_FROM || env.MAIL_USERNAME || 'drawDB <drawdb@localhost>',
  },
};

/** An SMTP host (sign-in optional), or a service with credentials. */
export const mailEnabled = () =>
  Boolean(config.mail.host || (config.mail.username && config.mail.password));
