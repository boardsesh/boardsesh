import crypto from 'crypto';
import { parseAccountCreationReceipt, type AccountCreationReceipt } from '@boardsesh/analytics';

const NATIVE_OAUTH_TRANSFER_TTL_SECONDS = 120;
const CLOCK_SKEW_TOLERANCE_SECONDS = 5;

type NativeOAuthTransferPayload = {
  userId: string;
  nextPath: string;
  iat: number;
  exp: number;
  accountCreation?: AccountCreationReceipt;
  authSessionId?: string;
  attemptId?: string;
  provider?: 'apple' | 'google';
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
  accountCreation,
  authSessionId,
  attemptId,
  provider,
}: {
  userId: string;
  nextPath: string;
  accountCreation?: AccountCreationReceipt;
  authSessionId?: string;
  attemptId?: string;
  provider?: 'apple' | 'google';
}): string => {
  const now = Math.floor(Date.now() / 1000);
  const payload: NativeOAuthTransferPayload = {
    userId,
    nextPath: sanitizeNextPath(nextPath),
    iat: now,
    exp: now + NATIVE_OAUTH_TRANSFER_TTL_SECONDS,
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
): { userId: string; nextPath: string; accountCreation?: AccountCreationReceipt } | null => {
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
    ...(verifiedReceipt ? { accountCreation: verifiedReceipt } : {}),
  };
};

export const NATIVE_OAUTH_ATTEMPT_COOKIE = 'boardsesh-native-oauth-attempt';
export type NativeOAuthAttempt = { attemptId: string; provider: 'apple' | 'google'; startedAt: number };

/** Functional OAuth correlation only; this marker carries no account or campaign identity. */
export function issueNativeOAuthAttempt(attempt: Omit<NativeOAuthAttempt, 'startedAt'>): string {
  const encodedPayload = base64UrlEncode(
    JSON.stringify({ ...attempt, startedAt: Date.now(), kind: 'native-oauth-attempt' }),
  );
  const signature = crypto.createHmac('sha256', getNativeOAuthSecret()).update(encodedPayload).digest('base64url');
  return `${encodedPayload}.${signature}`;
}

export function verifyNativeOAuthAttempt(token: string | undefined): NativeOAuthAttempt | null {
  if (!token || token.length > 2048) return null;
  try {
    const segments = token.split('.');
    if (segments.length !== 2 || !segments[0] || !segments[1]) return null;
    const signature = Buffer.from(segments[1]);
    const expected = Buffer.from(
      crypto.createHmac('sha256', getNativeOAuthSecret()).update(segments[0]).digest('base64url'),
    );
    if (signature.length !== expected.length || !crypto.timingSafeEqual(signature, expected)) return null;
    const decoded: unknown = JSON.parse(base64UrlDecode(segments[0]));
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return null;
    const attempt = decoded as Record<string, unknown>;
    if (
      attempt.kind !== 'native-oauth-attempt' ||
      typeof attempt.attemptId !== 'string' ||
      !/^[0-9a-f]{32}$/.test(attempt.attemptId) ||
      (attempt.provider !== 'apple' && attempt.provider !== 'google') ||
      typeof attempt.startedAt !== 'number' ||
      !Number.isSafeInteger(attempt.startedAt) ||
      attempt.startedAt > Date.now() ||
      Date.now() - attempt.startedAt > NATIVE_OAUTH_TRANSFER_TTL_SECONDS * 1000
    )
      return null;
    return { attemptId: attempt.attemptId, provider: attempt.provider, startedAt: attempt.startedAt };
  } catch {
    return null;
  }
}
