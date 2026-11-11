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
import { checkRateLimit } from './rate-limiter';
import { trustedClientRateLimitKey } from './trusted-client-ip.server';

type AuthenticatedReply = Extract<PasswordReply, { outcome: 'authenticated' }>;

/** Same per-minute number as native login and web registration. */
const LOGIN_ATTEMPTS_PER_CLIENT = 10;

/** A new closure per HTTP request; no verdict or private reply lives in options shared by requests. */
export function createPasswordCommandAuthRequest(
  base: NextAuthOptions,
  clientFactory: () => PasswordCommandClient = createPasswordCommandClient,
) {
  let unavailable = false;
  let verdict: AuthenticatedReply | undefined;
  try {
    if (webPasswordMode() === 'legacy') return { options: base, unavailable: () => false };
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
        return { ...reply.user };
      } catch {
        return rejectUnavailable();
      }
    },
  });
  const options: NextAuthOptions = {
    ...base,
    providers: base.providers.map((existing) =>
      (existing.options?.id ?? existing.id) === 'credentials' ? provider : existing,
    ),
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

/**
 * Keeps one client from spending a shared login budget and locking out everyone
 * else. In staged mode that is the backend's process-wide budget. In legacy mode
 * it is this web process's event loop: every attempt, unknown address included,
 * costs about 200 ms of bcrypt here, so 5 a second from one client would fill it.
 * Counts before NextAuth reads the body, so a rejected attempt costs neither an
 * RPC nor a bcrypt comparison, and the answer is the same for every address.
 */
export function limitPasswordLoginPerClient(request: Request): Response | null {
  const { limited, retryAfterSeconds } = checkRateLimit(
    `password-login:${trustedClientRateLimitKey(request)}`,
    LOGIN_ATTEMPTS_PER_CLIENT,
    60_000,
  );
  return limited ? unavailablePasswordAuthResponse(request.url, retryAfterSeconds) : null;
}
