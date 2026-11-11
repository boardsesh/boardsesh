import 'server-only';
import { decode, encode } from 'next-auth/jwt';
import { NextRequest, NextResponse } from 'next/server';
import { setPasswordMode, webCredentialProofSchema, type WebCredentialProof } from '@boardsesh/auth-protocol';
import { capturePresentedWebCredential } from './admitted-session.server';
import { admitPresentedWebCredential } from './credential-admission.server';
import { createPasswordCommandClient, AuthBackendUnavailableError } from './password-command-client.server';
import { isSecureCookieContext, sessionCookieDomain } from './secure-cookies';

/** Preserve the exact session lineage, auth age and original expiry after the committed mutation. */
async function replacementResponse(
  request: NextRequest,
  credential: string,
  cookieName: string,
  proofInput: WebCredentialProof,
) {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new AuthBackendUnavailableError();
  const source = await decode({ token: credential, secret });
  const proof = webCredentialProofSchema.parse(proofInput);
  const sourceSessionId = source?.authSessionId ?? source?.jti;
  if (
    !source ||
    source.sub !== proof.userId ||
    sourceSessionId !== proof.authSessionId ||
    typeof source.exp !== 'number' ||
    proof.generation !== (source.gen ?? 0) + 1 ||
    (proof.authenticatedAt === null
      ? source.auth_time !== undefined
      : Date.parse(proof.authenticatedAt) !== (source.auth_time ?? 0) * 1000) ||
    proof.linkGuarded !== (source.link_guarded === true)
  )
    throw new AuthBackendUnavailableError();
  const token = { ...source, gen: proof.generation, authSessionId: proof.authSessionId };
  if (proof.authenticatedAt === null) delete token.auth_time;
  else token.auth_time = Math.floor(Date.parse(proof.authenticatedAt) / 1000);
  if (proof.linkGuarded && token.auth_time !== undefined) token.link_guarded = true;
  else delete token.link_guarded;
  const maxAge = Math.floor(source.exp - Date.now() / 1000);
  if (maxAge <= 0) throw new AuthBackendUnavailableError();
  const encoded = await encode({ token, secret, maxAge });
  // NextAuth chooses its own later encoding clock. Never extend the signed cap.
  const replacement = await decode({ token: encoded, secret });
  if (typeof replacement?.exp !== 'number' || replacement.exp > source.exp) throw new AuthBackendUnavailableError();
  // A later reset between backend commit and cookie emission cannot upgrade it.
  if ((await admitPresentedWebCredential(encoded)) !== proof.userId)
    return NextResponse.json({ error: 'reauthentication_required' }, { status: 403 });
  const response = NextResponse.json({ outcome: 'set' });
  const options = {
    httpOnly: true,
    secure: isSecureCookieContext(),
    sameSite: 'lax' as const,
    path: '/',
    ...(sessionCookieDomain() ? { domain: sessionCookieDomain() } : {}),
  };
  for (const cookie of request.cookies.getAll()) {
    if (cookie.name === cookieName || cookie.name.startsWith(`${cookieName}.`))
      response.cookies.set(cookie.name, '', { ...options, maxAge: 0 });
  }
  // Public NextAuth getToken reconstructs numbered chunks. Keep each serialized
  // cookie safely below browser limits, including the shared-domain attributes.
  const chunks = encoded.match(/.{1,3800}/g) ?? [];
  chunks.forEach((chunk, index) =>
    response.cookies.set(chunks.length === 1 ? cookieName : `${cookieName}.${index}`, chunk, { ...options, maxAge }),
  );
  return response;
}

async function delegate(
  request: NextRequest,
  password: string,
  confirmPassword: string,
  expected?: { userId: string; authSessionId: string },
): Promise<NextResponse | null> {
  if (setPasswordMode(process.env) === 'legacy') return null;
  if (!expected?.userId || !expected.authSessionId)
    return NextResponse.json({ error: 'identity_changed' }, { status: 409 });
  const presented = await capturePresentedWebCredential(request);
  if (!presented) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const reply = await createPasswordCommandClient().setPassword(
    presented.credential,
    password,
    confirmPassword,
    expected.userId,
    expected.authSessionId,
  );
  if (reply.outcome === 'set')
    return replacementResponse(request, presented.credential, presented.cookieName, reply.credentialProof);
  if (reply.outcome === 'reauthentication_required')
    return NextResponse.json({ error: reply.outcome }, { status: 403 });
  if (reply.outcome === 'unauthenticated') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (reply.outcome === 'identity_changed') return NextResponse.json({ error: reply.outcome }, { status: 409 });
  if (reply.outcome === 'already_set') return NextResponse.json({ error: 'Password already set.' }, { status: 409 });
  if (reply.outcome === 'error' && reply.code === 'rate_limited')
    return NextResponse.json(
      { error: 'Too many requests. Please try again later.' },
      { status: 429, headers: { 'Retry-After': String(reply.retryAfterSeconds) } },
    );
  throw new AuthBackendUnavailableError();
}

/** Sanitize every transport/decoder/schema failure before the public route can log it. */
export async function delegateSetPassword(
  request: NextRequest,
  password: string,
  confirmPassword: string,
  expected?: { userId: string; authSessionId: string },
): Promise<NextResponse | null> {
  try {
    return await delegate(request, password, confirmPassword, expected);
  } catch {
    throw new AuthBackendUnavailableError();
  }
}
