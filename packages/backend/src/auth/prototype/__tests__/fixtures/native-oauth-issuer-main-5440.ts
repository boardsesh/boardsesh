// Frozen producer from main 5440cb33bc458e95dd8d9f4991f0c8d4a89a3415:
// packages/web/app/lib/auth/native-oauth-transfer.ts (issuance functions only).
// Historical compatibility/security fixture: returning transfers omitted the SID
// unless creation metadata was present. Keep this released behavior independent
// of fixes to the live issuer. Inputs and signing secrets are synthetic test data.
import crypto from 'crypto';
import type { AccountCreationReceipt } from '@boardsesh/analytics';

const NATIVE_OAUTH_TRANSFER_TTL_SECONDS = 120;

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

export type NativeOAuthAttempt = { attemptId: string; provider: 'apple' | 'google'; startedAt: number };

/** Functional OAuth correlation only; this marker carries no account or campaign identity. */
export function issueNativeOAuthAttempt(attempt: Omit<NativeOAuthAttempt, 'startedAt'>): string {
  const encodedPayload = base64UrlEncode(
    JSON.stringify({ ...attempt, startedAt: Date.now(), kind: 'native-oauth-attempt' }),
  );
  const signature = crypto.createHmac('sha256', getNativeOAuthSecret()).update(encodedPayload).digest('base64url');
  return `${encodedPayload}.${signature}`;
}
