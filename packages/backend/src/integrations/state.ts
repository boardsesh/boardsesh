// Signed, purpose-bound tokens for the integration OAuth handshake.
//
// Two token kinds share the same HMAC envelope but are never interchangeable
// (the embedded `purpose` is checked on verification):
//
// - 'oauth-state': the OAuth `state` parameter. Carries the initiating
//   userId + provider through the redirect to the provider and back, so the
//   callback can attribute tokens without a server-side session. 10-minute
//   lifetime (the user completes the provider consent screen).
// - 'oauth-handoff': a short-lived, single-use code minted over an
//   authenticated GraphQL call and passed to GET /integrations/:provider/start
//   as a query parameter. The session JWT itself never enters a URL — query
//   strings end up in access logs, proxy logs, and browser history, so the
//   only thing allowed there is this 60-second purpose-bound code (the same
//   exposure class as an OAuth authorization code). Single-use enforcement is
//   Redis-backed in the start handler.
//
// Format mirrors verifyTransferToken in handlers/native-auth.ts: base64url JSON
// payload + '.' + base64url HMAC-SHA256, constant-time compare, iat/exp
// checks, lifetime cap, random nonce to defeat guessability. The HMAC key is
// HKDF-derived from NEXTAUTH_SECRET with a purpose-specific info string, so
// these tokens are domain-separated from NextAuth session tokens (and any
// other NEXTAUTH_SECRET consumer) without needing a second deployed secret.

import crypto from 'crypto';
import type { ProviderName } from './registry';
import { isSupportedProvider } from './registry';
import { logger } from '../utils/logger';

const HKDF_INFO = 'boardsesh-integration-oauth-tokens-v1';

let cachedSigningKey: { secret: string; key: Buffer } | null = null;

function getSigningKey(): Buffer | null {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) return null;
  if (cachedSigningKey && cachedSigningKey.secret === secret) {
    return cachedSigningKey.key;
  }
  const derived = Buffer.from(crypto.hkdfSync('sha256', secret, '', HKDF_INFO, 32));
  cachedSigningKey = { secret, key: derived };
  return derived;
}

/** State lifetime: a user has 10 minutes to complete the provider handshake. */
const STATE_LIFETIME_SECONDS = 10 * 60;

/** Handoff lifetime: the in-app browser opens the start URL immediately. */
const HANDOFF_LIFETIME_SECONDS = 60;

/** Clock skew tolerance for iat/exp checks (seconds). */
const CLOCK_SKEW_TOLERANCE_SECONDS = 5;

type TokenPurpose = 'oauth-state' | 'oauth-handoff';

type SignedPayload = {
  purpose: TokenPurpose;
  userId: string;
  provider: ProviderName;
  nonce: string;
  iat: number;
  exp: number;
};

export type VerifiedIntegrationToken = {
  userId: string;
  provider: ProviderName;
  nonce: string;
};

function signPayload(
  input: { userId: string; provider: ProviderName },
  purpose: TokenPurpose,
  lifetimeSeconds: number,
): string {
  const signingKey = getSigningKey();
  if (!signingKey) {
    throw new Error('NEXTAUTH_SECRET is not configured');
  }

  const now = Math.floor(Date.now() / 1000);
  const payload: SignedPayload = {
    purpose,
    userId: input.userId,
    provider: input.provider,
    nonce: crypto.randomBytes(16).toString('base64url'),
    iat: now,
    exp: now + lifetimeSeconds,
  };

  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', signingKey).update(encodedPayload).digest('base64url');
  return `${encodedPayload}.${signature}`;
}

function verifySignedPayload(
  token: string,
  expectedPurpose: TokenPurpose,
  lifetimeSeconds: number,
): VerifiedIntegrationToken | null {
  const signingKey = getSigningKey();
  if (!signingKey) {
    logger.warn('[Integrations] NEXTAUTH_SECRET not configured');
    return null;
  }

  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }
  const [encodedPayload, signature] = parts;

  const expectedSignature = crypto.createHmac('sha256', signingKey).update(encodedPayload).digest('base64url');

  const sigBuffer = Buffer.from(signature);
  const expectedSigBuffer = Buffer.from(expectedSignature);

  // Pad both buffers to the same length so the comparison is always
  // constant-time — no length oracle, no JIT short-circuit.
  const maxLen = Math.max(sigBuffer.length, expectedSigBuffer.length);
  const paddedSig = Buffer.alloc(maxLen);
  const paddedExpected = Buffer.alloc(maxLen);
  sigBuffer.copy(paddedSig);
  expectedSigBuffer.copy(paddedExpected);

  if (!crypto.timingSafeEqual(paddedSig, paddedExpected)) {
    return null;
  }

  let payload: SignedPayload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as SignedPayload;
  } catch {
    return null;
  }

  // Purpose binding: a handoff code must never be replayable as an OAuth
  // state (or vice versa) — they have different lifetimes and trust levels.
  if (payload.purpose !== expectedPurpose) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (
    !payload.userId ||
    !payload.provider ||
    !payload.nonce ||
    !payload.exp ||
    !payload.iat ||
    payload.exp < now - CLOCK_SKEW_TOLERANCE_SECONDS ||
    payload.iat > now + CLOCK_SKEW_TOLERANCE_SECONDS
  ) {
    return null;
  }

  // Reject tokens whose embedded lifetime exceeds the contract — a tampered or
  // forged payload could otherwise claim a far-future exp.
  if (payload.exp - payload.iat > lifetimeSeconds + CLOCK_SKEW_TOLERANCE_SECONDS) {
    return null;
  }

  if (!isSupportedProvider(payload.provider)) {
    return null;
  }

  return { userId: payload.userId, provider: payload.provider, nonce: payload.nonce };
}

export function signIntegrationState(input: { userId: string; provider: ProviderName }): string {
  return signPayload(input, 'oauth-state', STATE_LIFETIME_SECONDS);
}

export function verifyIntegrationState(state: string): VerifiedIntegrationToken | null {
  return verifySignedPayload(state, 'oauth-state', STATE_LIFETIME_SECONDS);
}

export function signIntegrationHandoff(input: { userId: string; provider: ProviderName }): string {
  return signPayload(input, 'oauth-handoff', HANDOFF_LIFETIME_SECONDS);
}

export function verifyIntegrationHandoff(handoff: string): VerifiedIntegrationToken | null {
  return verifySignedPayload(handoff, 'oauth-handoff', HANDOFF_LIFETIME_SECONDS);
}
