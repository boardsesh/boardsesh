import 'server-only';
import type { NextAuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import { AUTH_BACKEND_UNAVAILABLE, type PasswordReply } from '@boardsesh/auth-protocol';
import {
  AuthBackendUnavailableError,
  createPasswordCommandClient,
  webPasswordMode,
  type PasswordCommandClient,
} from './password-command-client.server';
import { resolvePublicAuthOrigin } from './canonical-auth-url';
import { checkRateLimit, releaseRateLimitAttempt } from './rate-limiter';
import { cloudflareVisitorRateLimitKey, trustedClientRateLimitKey } from './trusted-client-ip.server';

type AuthenticatedReply = Extract<PasswordReply, { outcome: 'authenticated' }>;
type Provider = NextAuthOptions['providers'][number];
type CredentialsConfig = Parameters<typeof CredentialsProvider>[0];

/** Same per-minute number as native login and web registration. */
const LOGIN_ATTEMPTS_PER_CLIENT = 10;
const LOGIN_WINDOW_MS = 60_000;
/** How often the log may say the limit was skipped for want of a trusted client address. */
const UNKEYED_WARNING_INTERVAL_MS = 60_000;

function isCredentialsProvider(provider: Provider): boolean {
  return ((provider.options as { id?: string } | undefined)?.id ?? provider.id) === 'credentials';
}

/**
 * The legacy credentials provider, calling `onPasswordAccepted` whenever its own
 * authorize accepts a password. NextAuth reads a provider's settings from its
 * `options`, so that is where the original authorize lives.
 */
function reportAcceptedPassword(existing: Provider, onPasswordAccepted: () => void): Provider {
  const configured = { ...existing, ...(existing.options as Partial<CredentialsConfig> | undefined) };
  const { authorize } = configured as Pick<CredentialsConfig, 'authorize'>;
  return CredentialsProvider({
    id: configured.id,
    name: configured.name,
    credentials: (configured as Pick<CredentialsConfig, 'credentials'>).credentials,
    async authorize(credentials, request) {
      const user = await authorize(credentials, request);
      if (user) onPasswordAccepted();
      return user;
    },
  });
}

/**
 * A new closure per HTTP request; no verdict or private reply lives in options shared by requests.
 * `onPasswordAccepted` runs when the submitted password is right, so the
 * per-client limit can give that attempt back.
 */
export function createPasswordCommandAuthRequest(
  base: NextAuthOptions,
  clientFactory: () => PasswordCommandClient = createPasswordCommandClient,
  onPasswordAccepted: () => void = () => {},
) {
  let unavailable = false;
  let verdict: AuthenticatedReply | undefined;
  try {
    if (webPasswordMode() === 'legacy') {
      const options: NextAuthOptions = {
        ...base,
        providers: base.providers.map((existing) =>
          isCredentialsProvider(existing) ? reportAcceptedPassword(existing, onPasswordAccepted) : existing,
        ),
      };
      return { options, unavailable: () => false };
    }
  } catch {
    unavailable = true;
  }
  const rejectUnavailable = (): never => {
    unavailable = true;
    throw new AuthBackendUnavailableError();
  };
  const provider = CredentialsProvider({
    name: 'Email',
    credentials: {
      email: { label: 'Email', type: 'email', placeholder: 'your@email.com' },
      password: { label: 'Password', type: 'password' },
    },
    async authorize(credentials) {
      verdict = undefined;
      if (unavailable) return rejectUnavailable();
      if (!credentials?.email || !credentials.password) return null;
      try {
        const reply = await clientFactory().password(credentials.email, credentials.password);
        if (reply.outcome === 'invalid_credentials') return null;
        if (reply.outcome !== 'authenticated') return rejectUnavailable();
        verdict = reply;
        onPasswordAccepted();
        return { ...reply.user };
      } catch {
        return rejectUnavailable();
      }
    },
  });
  const options: NextAuthOptions = {
    ...base,
    providers: base.providers.map((existing) => (isCredentialsProvider(existing) ? provider : existing)),
    callbacks: {
      ...base.callbacks,
      async signIn(parameters) {
        if (parameters.account?.provider !== 'credentials') return (await base.callbacks?.signIn?.(parameters)) ?? true;
        if (
          !verdict ||
          unavailable ||
          verdict.user.id !== parameters.user.id ||
          verdict.verification.userId !== parameters.user.id
        ) {
          return rejectUnavailable();
        }
        return verdict.verification.required && !verdict.verification.verified
          ? '/auth/verify-request?error=EmailNotVerified'
          : true;
      },
    },
  };
  return { options, unavailable: () => unavailable };
}

/** NextAuth converts authorize exceptions into redirects/401; preserve a retryable public result. */
export function unavailablePasswordAuthResponse(requestUrl: string, retryAfterSeconds?: number): Response {
  // The configured site, never the request's own URL: the standalone server
  // builds that from its bind address. The fallback is local development only.
  const errorUrl = new URL('/auth/error', resolvePublicAuthOrigin() ?? requestUrl);
  errorUrl.searchParams.set('error', AUTH_BACKEND_UNAVAILABLE);
  // No Set-Cookie: an existing login must survive a failed attempt on this form.
  return Response.json(
    { url: errorUrl.href },
    {
      status: retryAfterSeconds === undefined ? 503 : 429,
      headers: {
        'Cache-Control': 'private, no-store',
        // The limiter can report zero at its exact reset boundary.
        ...(retryAfterSeconds === undefined ? {} : { 'Retry-After': String(Math.max(1, retryAfterSeconds)) }),
      },
    },
  );
}

let lastUnkeyedWarningAt = Number.NEGATIVE_INFINITY;

/** Staged keeps its existing key. Legacy keys only on a visitor Cloudflare vouches for. */
function passwordLoginClientKey(request: Request): string | null {
  try {
    if (webPasswordMode() === 'backend-staging') return trustedClientRateLimitKey(request);
  } catch {
    // An invalid mode answers 503 before any password is checked; key it like legacy.
  }
  return cloudflareVisitorRateLimitKey(request);
}

export interface PasswordLoginAdmission {
  /** The 429 to send instead of signing in, or null to go ahead. */
  readonly limitedResponse: Response | null;
  /** Gives this attempt back. Call it when the password was right. */
  readonly passwordAccepted: () => void;
}

/**
 * Keeps one client from spending a shared login budget and locking out everyone
 * else. In staged mode that is the backend's process-wide budget. In legacy mode
 * it is this web process's event loop: every attempt, unknown address included,
 * costs about 200 ms of bcrypt here, so 5 a second from one client would fill it.
 *
 * Only rejected passwords use up the 10 a minute. The attempt is counted here,
 * before NextAuth reads the body, and given back when the password is right, so
 * parallel requests cannot all pass before any is counted. A limited attempt
 * costs neither an RPC nor a bcrypt comparison, and its answer is the same for
 * every address.
 *
 * Legacy mode skips the limit when no trusted client address is on the request,
 * rather than put every visitor in one bucket and cap the whole site at 10 a
 * minute. It says so in the log at most once a minute.
 */
export function admitPasswordLogin(request: Request): PasswordLoginAdmission {
  const clientKey = passwordLoginClientKey(request);
  if (clientKey === null) {
    const now = Date.now();
    if (now - lastUnkeyedWarningAt >= UNKEYED_WARNING_INTERVAL_MS) {
      lastUnkeyedWarningAt = now;
      console.warn(
        '[auth] Password sign-in ran without its per-client limit: no Cloudflare-vouched client address on the request',
      );
    }
    return { limitedResponse: null, passwordAccepted: () => {} };
  }
  const bucket = `password-login:${clientKey}`;
  const { limited, retryAfterSeconds } = checkRateLimit(bucket, LOGIN_ATTEMPTS_PER_CLIENT, LOGIN_WINDOW_MS);
  if (limited) {
    return {
      limitedResponse: unavailablePasswordAuthResponse(request.url, retryAfterSeconds),
      passwordAccepted: () => {},
    };
  }
  let givenBack = false;
  return {
    limitedResponse: null,
    passwordAccepted: () => {
      if (givenBack) return;
      givenBack = true;
      releaseRateLimitAttempt(bucket);
    },
  };
}
