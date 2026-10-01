import { createHash } from 'crypto';
import { config } from '../config';
import { randomToken } from './crypto';

export interface OAuthProfile {
  providerUserId: string;
  email: string | null;
  emailVerified: boolean;
  name: string;
  avatarUrl: string | null;
}

interface Provider {
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  credentials: () => { clientId: string; clientSecret: string } | null;
  fetchProfile: (accessToken: string) => Promise<OAuthProfile>;
}

async function getJson<T>(url: string, accessToken: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'User-Agent': 'drawdb-server',
    },
  });
  if (!res.ok) throw new Error(`${url} responded ${res.status}`);
  return (await res.json()) as T;
}

const providers: Record<string, Provider> = {
  google: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
    credentials: () => config.auth.oauth.google,
    async fetchProfile(accessToken) {
      const p = await getJson<{
        sub: string;
        email?: string;
        email_verified?: boolean;
        name?: string;
        picture?: string;
      }>('https://openidconnect.googleapis.com/v1/userinfo', accessToken);
      return {
        providerUserId: p.sub,
        email: p.email ?? null,
        emailVerified: p.email_verified === true,
        name: p.name ?? '',
        avatarUrl: p.picture ?? null,
      };
    },
  },
  github: {
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scope: 'read:user user:email',
    credentials: () => config.auth.oauth.github,
    async fetchProfile(accessToken) {
      const user = await getJson<{ id: number; login: string; name: string | null; avatar_url: string }>(
        'https://api.github.com/user',
        accessToken,
      );
      // The profile email may be hidden; the emails endpoint says which is
      // primary and verified
      const emails = await getJson<{ email: string; primary: boolean; verified: boolean }[]>(
        'https://api.github.com/user/emails',
        accessToken,
      );
      const primary = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
      return {
        providerUserId: String(user.id),
        email: primary?.email ?? null,
        emailVerified: Boolean(primary),
        name: user.name || user.login,
        avatarUrl: user.avatar_url,
      };
    },
  },
};

export const enabledProviders = () =>
  Object.keys(providers).filter((id) => providers[id].credentials() !== null);

export const getProvider = (id: string) => {
  const provider = providers[id];
  return provider && provider.credentials() ? provider : null;
};

export const callbackUrl = (id: string) => `${config.server.publicApiUrl}/auth/oauth/${id}/callback`;

/** State and PKCE verifier for one sign-in attempt, kept in a cookie. */
export function createAttempt(returnTo: string) {
  const state = randomToken();
  const verifier = randomToken();
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { state, verifier, challenge, returnTo };
}

export function authorizationUrl(id: string, provider: Provider, state: string, challenge: string) {
  const url = new URL(provider.authorizeUrl);
  url.search = new URLSearchParams({
    client_id: provider.credentials()!.clientId,
    redirect_uri: callbackUrl(id),
    response_type: 'code',
    scope: provider.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...(id === 'google' ? { prompt: 'select_account' } : {}),
  }).toString();
  return url.toString();
}

export async function exchangeCode(id: string, provider: Provider, code: string, verifier: string) {
  const { clientId, clientSecret } = provider.credentials()!;
  const res = await fetch(provider.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: callbackUrl(id),
      client_id: clientId,
      client_secret: clientSecret,
      code_verifier: verifier,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (!res.ok || !body.access_token) {
    throw new Error(`Token exchange failed: ${body.error ?? res.status}`);
  }
  return body.access_token;
}

/** Only same-app relative paths, so the redirect can't leave the app. */
export function safeReturnTo(value: unknown) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    return '/';
  }
  return value.slice(0, 500);
}
