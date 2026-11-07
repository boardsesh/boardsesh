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

type AuthenticatedReply = Extract<PasswordReply, { outcome: 'authenticated' }>;

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
export function unavailablePasswordAuthResponse(requestUrl: string): Response {
  const errorUrl = new URL('/auth/error', requestUrl);
  errorUrl.searchParams.set('error', AUTH_BACKEND_UNAVAILABLE);
  // No Set-Cookie: an existing login must survive a failed attempt on this form.
  return Response.json(
    { url: errorUrl.href },
    {
      status: 503,
      headers: { 'Cache-Control': 'private, no-store' },
    },
  );
}
