import { webCredentialProofSchema, type WebCredentialProof } from '@boardsesh/auth-protocol';
import {
  createNativeOAuthTransferCodec,
  NATIVE_OAUTH_TRANSFER_TTL_SECONDS,
} from '@boardsesh/auth-protocol/native-oauth-transfer';
import crypto from 'crypto';
import { signNativeOAuthAttempt, readNativeOAuthAttempt, type NativeOAuthAttempt } from './native-oauth-attempt.server';
export { NATIVE_OAUTH_ATTEMPT_COOKIE, type NativeOAuthAttempt } from './native-oauth-attempt.server';
import { parseAccountCreationReceipt, type AccountCreationReceipt } from '@boardsesh/analytics';

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

const transferCodec = createNativeOAuthTransferCodec({
  encode: (text) => Buffer.from(text, 'utf8').toString('base64url'),
  decode: (encoded) => Buffer.from(encoded, 'base64url').toString('utf8'),
  hmac: (text, secret) => crypto.createHmac('sha256', secret).update(text).digest('base64url'),
  equal: (actual, expected) => {
    const actualBytes = Buffer.from(actual);
    const expectedBytes = Buffer.from(expected);
    return actualBytes.length === expectedBytes.length && crypto.timingSafeEqual(actualBytes, expectedBytes);
  },
  hash: (text) => crypto.createHash('sha256').update(text).digest('hex'),
});

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

/** Browser fallback verifier; native exchange retains its own protocol. */
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
  const decoded = transferCodec.readNativeOAuthTransfer(token, secret, Date.now());
  if (!decoded) return null;
  const receipt = parseAccountCreationReceipt(decoded.accountCreation);
  const verifiedReceipt =
    receipt?.userId === decoded.userId &&
    receipt.provider === decoded.provider &&
    typeof decoded.authSessionId === 'string' &&
    decoded.authSessionId.length > 0 &&
    typeof decoded.attemptId === 'string' &&
    /^[0-9a-f]{32}$/.test(decoded.attemptId)
      ? receipt
      : undefined;
  return {
    userId: decoded.userId,
    nextPath: decoded.nextPath,
    generation: decoded.generation,
    ...(verifiedReceipt ? { accountCreation: verifiedReceipt } : {}),
    ...(decoded.credentialProof ? { credentialProof: decoded.credentialProof } : {}),
  };
};

/** Exact legacy durable replay marker; verification is a separate prerequisite. */
export const nativeOAuthTransferSpentMarker = (
  token: string,
): { identifier: string; token: string; expires: Date } | null => {
  try {
    return transferCodec.nativeOAuthTransferSpentMarker(token, getNativeOAuthSecret());
  } catch {
    return null;
  }
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
