import { webCredentialProofSchema, type WebCredentialProof } from '@boardsesh/auth-protocol';
import crypto from 'crypto';
import { signNativeOAuthAttempt, readNativeOAuthAttempt, type NativeOAuthAttempt } from './native-oauth-attempt.server';
export { NATIVE_OAUTH_ATTEMPT_COOKIE, type NativeOAuthAttempt } from './native-oauth-attempt.server';
import { parseAccountCreationReceipt, type AccountCreationReceipt } from '@boardsesh/analytics';

const NATIVE_OAUTH_TRANSFER_TTL_SECONDS = 120;
const CLOCK_SKEW_TOLERANCE_SECONDS = 5;

type NativeOAuthTransferPayload = {
  userId: string;
  nextPath: string;
  iat: number;
  exp: number;
  gen: number;
  accountCreation?: AccountCreationReceipt;
  authSessionId?: string;
  attemptId?: string;
  provider?: 'apple' | 'google';
  auth_time?: number;
  link_guarded?: true;
  legacy_no_sid?: true;
};

const base64UrlEncode = (value: string): string => Buffer.from(value, 'utf8').toString('base64url');

const base64UrlDecode = (value: string): string => Buffer.from(value, 'base64url').toString('utf8');

const getNativeOAuthSecret = (): string => {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error('NEXTAUTH_SECRET is required for native OAuth transfer flow');
  }
  return secret;
};

const sanitizeNextPath = (nextPath: string): string => (nextPath.startsWith('/') ? nextPath : '/');

export const issueNativeOAuthTransferToken = ({
  userId,
  nextPath,
  generation = 0,
  accountCreation,
  authSessionId,
  attemptId,
  provider,
  credentialProof,
}: {
  userId: string;
  nextPath: string;
  generation?: number;
  accountCreation?: AccountCreationReceipt;
  authSessionId?: string;
  attemptId?: string;
  provider?: 'apple' | 'google';
  credentialProof?: WebCredentialProof;
}): string => {
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error('Invalid native OAuth transfer generation');
  }
  const now = Math.floor(Date.now() / 1000);
  const proof = credentialProof ? webCredentialProofSchema.parse(credentialProof) : undefined;
  if (proof && (proof.userId !== userId || (authSessionId !== undefined && authSessionId !== proof.authSessionId)))
    throw new Error('Transfer proof identity mismatch');
  const payload: NativeOAuthTransferPayload = {
    userId,
    nextPath: sanitizeNextPath(nextPath),
    iat: now,
    exp: now + NATIVE_OAUTH_TRANSFER_TTL_SECONDS,
    gen: proof?.generation ?? generation,
    ...(authSessionId ? { authSessionId } : {}),
    ...(proof
      ? {
          authSessionId: proof.authSessionId,
          ...(proof.authenticatedAt ? { auth_time: Math.floor(Date.parse(proof.authenticatedAt) / 1000) } : {}),
          ...(proof.linkGuarded ? { link_guarded: true as const } : {}),
          ...(proof.requiresAccountCutoff ? { legacy_no_sid: true as const } : {}),
        }
      : {}),
    ...(accountCreation && authSessionId && attemptId && provider
      ? { accountCreation, authSessionId, attemptId, provider }
      : {}),
  };

  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = crypto.createHmac('sha256', getNativeOAuthSecret()).update(encodedPayload).digest('base64url');

  return `${encodedPayload}.${signature}`;
};

export const verifyNativeOAuthTransferToken = (
  token: string,
): {
  userId: string;
  nextPath: string;
  accountCreation?: AccountCreationReceipt;
  generation: number;
  credentialProof?: WebCredentialProof;
} | null => {
  let secret: string;
  try {
    secret = getNativeOAuthSecret();
  } catch {
    return null;
  }

  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }
  const [encodedPayload, signature] = parts;

  const expectedSignature = crypto.createHmac('sha256', secret).update(encodedPayload).digest('base64url');

  const sigBuffer = Buffer.from(signature);
  const expectedSigBuffer = Buffer.from(expectedSignature);

  if (sigBuffer.length !== expectedSigBuffer.length) {
    // Perform a no-op timingSafeEqual so this branch takes the same time as
    // the valid-length comparison below. The earlier structural checks
    // (missing payload/signature) return immediately — that's fine because
    // they don't reveal anything about a valid token's signature.
    crypto.timingSafeEqual(expectedSigBuffer, expectedSigBuffer);
    return null;
  }

  if (!crypto.timingSafeEqual(sigBuffer, expectedSigBuffer)) {
    return null;
  }

  let payload: NativeOAuthTransferPayload;
  try {
    payload = JSON.parse(base64UrlDecode(encodedPayload)) as NativeOAuthTransferPayload;
  } catch {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (
    !payload?.userId ||
    !payload?.nextPath ||
    !payload?.exp ||
    !payload?.iat ||
    payload.exp < now - CLOCK_SKEW_TOLERANCE_SECONDS ||
    payload.iat > now + CLOCK_SKEW_TOLERANCE_SECONDS
  ) {
    return null;
  }

  if (payload.gen !== undefined && (!Number.isSafeInteger(payload.gen) || payload.gen < 0)) return null;
  let credentialProof: WebCredentialProof | undefined;
  // Generation-only legacy transfers remain readable. A complete signed source
  // identity inherits its generation and unknown age without a primary restamp.
  if (
    (payload.gen !== undefined && payload.authSessionId !== undefined) ||
    payload.auth_time !== undefined ||
    payload.link_guarded !== undefined ||
    payload.legacy_no_sid !== undefined
  ) {
    if (
      payload.auth_time !== undefined &&
      (!Number.isSafeInteger(payload.auth_time) ||
        payload.auth_time <= 0 ||
        payload.auth_time > now + CLOCK_SKEW_TOLERANCE_SECONDS)
    )
      return null;
    const parsed = webCredentialProofSchema.safeParse({
      version: 1,
      userId: payload.userId,
      authSessionId: payload.authSessionId,
      generation: payload.gen,
      authenticatedAt: payload.auth_time === undefined ? null : new Date(payload.auth_time * 1000).toISOString(),
      linkGuarded: payload.link_guarded === true,
      ...(payload.legacy_no_sid !== undefined ? { requiresAccountCutoff: payload.legacy_no_sid } : {}),
    });
    if (!parsed.success) return null;
    credentialProof = parsed.data;
  }
  const receipt = parseAccountCreationReceipt(payload.accountCreation);
  const verifiedReceipt =
    receipt?.userId === payload.userId &&
    receipt.provider === payload.provider &&
    typeof payload.authSessionId === 'string' &&
    payload.authSessionId.length > 0 &&
    typeof payload.attemptId === 'string' &&
    /^[0-9a-f]{32}$/.test(payload.attemptId)
      ? receipt
      : undefined;
  return {
    userId: payload.userId,
    nextPath: sanitizeNextPath(payload.nextPath),
    generation: payload.gen ?? 0,
    ...(verifiedReceipt ? { accountCreation: verifiedReceipt } : {}),
    ...(credentialProof ? { credentialProof } : {}),
  };
};

/** Functional OAuth correlation only; this marker carries no account or campaign identity. */
export function issueNativeOAuthAttempt(attempt: Omit<NativeOAuthAttempt, 'startedAt'>): string {
  return signNativeOAuthAttempt(attempt, getNativeOAuthSecret(), Date.now());
}

export function verifyNativeOAuthAttempt(token: string | undefined): NativeOAuthAttempt | null {
  try {
    return readNativeOAuthAttempt(token, getNativeOAuthSecret(), Date.now());
  } catch {
    return null;
  }
}
