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
import { stagedPasswordClientKey } from './trusted-client-ip.server';

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
 * Keeps one client from spending the backend's process-wide login budget, which
 * would lock out everyone else. Staged mode only: legacy sign-in has no such
 * budget and keeps its existing route. Counts before NextAuth, so a rejected
 * attempt costs neither an RPC nor a bcrypt comparison.
 */
export function limitPasswordLoginPerClient(request: Request): Response | null {
  const clientKey = stagedPasswordClientKey(request);
  if (clientKey === null) return null;
  const { limited, retryAfterSeconds } = checkRateLimit(
    `password-login:${clientKey}`,
    LOGIN_ATTEMPTS_PER_CLIENT,
    60_000,
  );
  return limited ? unavailablePasswordAuthResponse(request.url, retryAfterSeconds) : null;
}
