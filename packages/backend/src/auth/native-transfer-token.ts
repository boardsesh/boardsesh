import crypto from 'node:crypto';
import { readAuthTimeClaim } from '@boardsesh/auth-protocol/auth-time';
import { parseAccountCreationReceipt, type AccountCreationReceipt } from '@boardsesh/analytics';
import { AuthAdmissionUnavailableError } from './admission-read-runner';
import { nativeSessionRequiresAccountCutoff } from './native-session-ancestry';

// Transfer tokens are short-lived (120s) and exchanged between our own
// servers, so 5s tolerance is sufficient. Long-lived JWTs use 60s in
// jose's clockTolerance to handle mobile device clock drift.
const CLOCK_SKEW_TOLERANCE_SECONDS = 5;

/**
 * Maximum allowed lifetime for a transfer token (seconds).
 * Transfer tokens are intended to live 120s. This cap (120s + 5s tolerance)
 * prevents a compromised web issuer from embedding an arbitrarily long exp.
 */
const MAX_TRANSFER_TOKEN_LIFETIME_SECONDS = 125;

/** A base64url payload, a dot, and the 43-character base64url HMAC-SHA256. Nothing else. */
const TRANSFER_TOKEN_SHAPE = /^([A-Za-z0-9_-]{1,8192})\.([A-Za-z0-9_-]{43})$/;

/** What a verified transfer token carries. */
export interface VerifiedNativeTransfer {
  /**
   * The token's single-use key: the RECOMPUTED signature, never the presented
   * bytes, so every spelling a verifier could accept spends the same key.
   */
  replayKey: string;
  userId: string;
  generation: number;
  authSessionId: string | null;
  authenticatedAt: Date | null;
  accountCreation?: AccountCreationReceipt;
  requiresAccountCutoff: boolean;
  validUntil: number;
}

type TransferPayload = {
  userId: string;
  nextPath: string;
  iat: number;
  exp: number;
  accountCreation?: unknown;
  gen?: unknown;
  auth_time?: unknown;
  link_guarded?: unknown;
  legacy_no_sid?: unknown;
  authSessionId?: unknown;
  attemptId?: unknown;
  provider?: unknown;
};

/**
 * Verifies a native OAuth transfer token (mirrors packages/web
 * native-oauth-transfer.ts): the HMAC under `NEXTAUTH_SECRET`, the issue and
 * expiry times, and the claims. Single use is the caller's job, keyed on
 * `replayKey`. Throws unavailable without the secret.
 */
export function verifyNativeTransferToken(token: string): VerifiedNativeTransfer | null {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new AuthAdmissionUnavailableError();

  // Exactly `<payload>.<signature>`, both canonical base64url: no padding,
  // whitespace, trailing bytes or third segment, so one token has one spelling.
  const match = TRANSFER_TOKEN_SHAPE.exec(token);
  if (!match) return null;
  const [, encodedPayload, signature] = match;
  if (Buffer.from(encodedPayload, 'base64url').toString('base64url') !== encodedPayload) return null;

  const expectedSignature = crypto.createHmac('sha256', secret).update(encodedPayload).digest('base64url');
  // The signature's length is public (43 characters); a different length is
  // refused before the constant-time comparison of equal-length buffers.
  const sigBuffer = Buffer.from(signature, 'utf8');
  const expectedSigBuffer = Buffer.from(expectedSignature, 'utf8');
  if (sigBuffer.length !== expectedSigBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedSigBuffer)) {
    return null;
  }

  let payload: TransferPayload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as TransferPayload;
  } catch {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (
    typeof payload.userId !== 'string' ||
    !payload.userId ||
    payload.userId.length > 256 ||
    !Number.isSafeInteger(payload.exp) ||
    !Number.isSafeInteger(payload.iat) ||
    payload.exp <= payload.iat ||
    payload.iat <= 0 ||
    payload.exp < now - CLOCK_SKEW_TOLERANCE_SECONDS ||
    payload.iat > now + CLOCK_SKEW_TOLERANCE_SECONDS
  ) {
    return null;
  }

  // Reject tokens with an unreasonably long lifetime (e.g. a compromised
  // web issuer embedding a far-future exp).
  if (payload.exp - payload.iat > MAX_TRANSFER_TOKEN_LIFETIME_SECONDS) {
    return null;
  }

  const receipt = parseAccountCreationReceipt(payload.accountCreation);
  const accountCreation =
    receipt?.userId === payload.userId &&
    receipt.provider === payload.provider &&
    typeof payload.authSessionId === 'string' &&
    payload.authSessionId.length > 0 &&
    typeof payload.attemptId === 'string' &&
    /^[0-9a-f]{32}$/.test(payload.attemptId)
      ? receipt
      : undefined;
  const generation = payload.gen ?? 0;
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 0) return null;
  if (
    payload.authSessionId !== undefined &&
    (typeof payload.authSessionId !== 'string' || !payload.authSessionId.trim() || payload.authSessionId.length > 256)
  )
    return null;
  if (payload.legacy_no_sid !== undefined && payload.legacy_no_sid !== true) return null;
  const sourceSessionId = typeof payload.authSessionId === 'string' ? payload.authSessionId : null;
  const inheritedAncestry = sourceSessionId === null ? true : nativeSessionRequiresAccountCutoff(sourceSessionId);
  if (inheritedAncestry === null) return null;
  const authenticationTime = readAuthTimeClaim(payload.auth_time, Date.now());
  const authenticatedAt =
    payload.link_guarded === true && authenticationTime !== null && authenticationTime <= payload.iat
      ? new Date(authenticationTime * 1000)
      : null;
  return {
    replayKey: expectedSignature,
    userId: payload.userId,
    generation,
    authSessionId: sourceSessionId,
    requiresAccountCutoff: payload.legacy_no_sid === true || inheritedAncestry,
    // The installed verifier compares integer seconds with an inclusive
    // tolerance. Reject at the first millisecond outside that same window.
    validUntil: (payload.exp + CLOCK_SKEW_TOLERANCE_SECONDS + 1) * 1000,
    authenticatedAt,
    ...(accountCreation ? { accountCreation } : {}),
  };
}
