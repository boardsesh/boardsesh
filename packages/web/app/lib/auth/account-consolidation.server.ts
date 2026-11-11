import { encodeConsolidationCookie } from './consolidation-cookie-codec.server';
import 'server-only';
import { decode } from 'next-auth/jwt';
import { NextRequest } from 'next/server';
import { createAuthCommandTransport } from './auth-command-transport.server';
import { capturePresentedWebCredential } from './admitted-session.server';
import { CredentialAuthorityUnavailable } from './credential-admission.server';
import { parseAccountConsolidationReceipt } from '@boardsesh/auth-protocol/account-consolidation';

const COMMAND_PATH = '/api/internal/auth/account-consolidation/web';
function enabled() {
  return process.env.ACCOUNT_CONSOLIDATION_BRIDGE_MODE === 'enabled';
}
async function command(operation: 'enroll' | 'exchange' | 'revoke', credential: string) {
  try {
    const transport = createAuthCommandTransport({ paths: [COMMAND_PATH] });
    const response = await transport.post(COMMAND_PATH, { operation, credential });
    if (response.status === 401) return null;
    if (response.status !== 200 || typeof response.body !== 'object' || response.body === null)
      throw new CredentialAuthorityUnavailable();
    return response.body as Record<string, unknown>;
  } catch {
    throw new CredentialAuthorityUnavailable();
  }
}

/** Only a completed sign-in response may create new proven web lineage. */
export async function enrollConsolidationSignIn(credential: string): Promise<void> {
  if (enabled()) await command('enroll', credential);
}
export async function revokeConsolidationCookie(credential: string): Promise<void> {
  // Disabling new transfers never disables revocation of prior transferred cookies.
  // An unconfigured, pre-rollout installation has no consolidated lineage.
  const configured = Boolean(
    process.env.CURRENT_STORE_AUTH_BACKEND_ORIGIN && process.env.CURRENT_STORE_AUTH_RPC_SECRET,
  );
  if (enabled() || configured) await command('revoke', credential);
  else {
    const secret = process.env.NEXTAUTH_SECRET;
    const token = secret ? await decode({ token: credential, secret }) : null;
    if (token?.accountConsolidation || token?.consolidationLineageTracked) throw new CredentialAuthorityUnavailable();
  }
}

/** Writable session routes only. Readonly SSR never aliases an old subject. */
export async function consolidationSessionRequest(request: NextRequest): Promise<NextRequest> {
  if (!enabled()) return request;
  const captured = await capturePresentedWebCredential(request);
  if (!captured) return request;
  const replacement = await command('exchange', captured.credential);
  if (!replacement) return request;
  const secret = process.env.NEXTAUTH_SECRET;
  if (
    !secret ||
    replacement.outcome !== 'transferred' ||
    typeof replacement.sub !== 'string' ||
    typeof replacement.sessionId !== 'string' ||
    !replacement.sessionId ||
    typeof replacement.expiresAt !== 'number' ||
    typeof replacement.issuedAt !== 'number' ||
    typeof replacement.generation !== 'number' ||
    !Number.isSafeInteger(replacement.generation)
  )
    throw new CredentialAuthorityUnavailable();
  const original = await decode({ token: captured.credential, secret });
  if (
    typeof original?.exp !== 'number' ||
    typeof original.iat !== 'number' ||
    replacement.expiresAt > original.exp ||
    replacement.issuedAt > original.iat
  )
    throw new CredentialAuthorityUnavailable();
  if (!original?.sub || !parseAccountConsolidationReceipt(replacement.receipt, original.sub, replacement.sub))
    throw new CredentialAuthorityUnavailable();
  const token = {
    ...original,
    name: typeof replacement.name === 'string' ? replacement.name : null,
    email: typeof replacement.email === 'string' ? replacement.email : null,
    picture: typeof replacement.image === 'string' ? replacement.image : null,
    sub: replacement.sub,
    id: replacement.sub,
    gen: replacement.generation,
    authSessionId: replacement.sessionId,
    accountConsolidation: replacement.receipt,
    accountConsolidationFromSessionId: original.authSessionId,
    accountConsolidationExpiresAt: replacement.expiresAt,
    accountConsolidationIssuedAt: replacement.issuedAt,
  };
  // Profile/creation metadata belongs to the old account; the normal callback refills it.
  delete token.nativeOAuthCreationProof;
  delete token.profileAvatarUrl;
  delete token.profileDisplayName;
  delete token.profileClaimsRefreshedAt;
  const credential = await encodeConsolidationCookie({ token, secret });
  const headers = new Headers(request.headers);
  // Remove every chunk of this cookie family, then install one complete cookie.
  const retained = request.cookies
    .getAll()
    .filter(({ name }) => name !== captured.cookieName && !name.startsWith(`${captured.cookieName}.`));
  headers.set(
    'cookie',
    [
      ...retained.map(({ name, value }) => `${name}=${encodeURIComponent(value)}`),
      `${captured.cookieName}=${encodeURIComponent(credential)}`,
    ].join('; '),
  );
  return new NextRequest(request.url, { headers, method: request.method });
}

/** A stale source tab may end only the canonical lineage derived from its exact original SID. */
export function matchesConsolidatedSignOut(
  token: Readonly<Record<string, unknown>> | null,
  expected: { readonly userId: string; readonly authSessionId: string },
): boolean {
  return Boolean(
    token &&
    typeof token.sub === 'string' &&
    token.accountConsolidationFromSessionId === expected.authSessionId &&
    parseAccountConsolidationReceipt(token.accountConsolidation, expected.userId, token.sub),
  );
}

/** Sign-out may retire a tracked cookie even after its source subject was retired. */
export async function isTrackedConsolidationCookie(credential: string): Promise<boolean> {
  if (enabled()) return true;
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new CredentialAuthorityUnavailable();
  try {
    const token = await decode({ token: credential, secret });
    return Boolean(token?.consolidationLineageTracked || token?.accountConsolidation);
  } catch {
    throw new CredentialAuthorityUnavailable();
  }
}
