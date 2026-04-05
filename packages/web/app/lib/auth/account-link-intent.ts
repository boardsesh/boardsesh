import crypto from 'crypto';

const LINK_INTENT_TTL_SECONDS = 300; // 5 minutes
const CLOCK_SKEW_TOLERANCE_SECONDS = 5;

type AccountLinkIntentPayload = {
  userId: string;
  iat: number;
  exp: number;
};

const base64UrlEncode = (value: string): string =>
  Buffer.from(value, 'utf8').toString('base64url');

const base64UrlDecode = (value: string): string =>
  Buffer.from(value, 'base64url').toString('utf8');

const getSecret = (): string => {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error('NEXTAUTH_SECRET is required for account link intent');
  }
  return secret;
};

export const issueAccountLinkIntentToken = (userId: string): string => {
  const now = Math.floor(Date.now() / 1000);
  const payload: AccountLinkIntentPayload = {
    userId,
    iat: now,
    exp: now + LINK_INTENT_TTL_SECONDS,
  };

  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = crypto
    .createHmac('sha256', getSecret())
    .update(encodedPayload)
    .digest('base64url');

  return `${encodedPayload}.${signature}`;
};

export const verifyAccountLinkIntentToken = (
  token: string,
): { userId: string } | null => {
  let secret: string;
  try {
    secret = getSecret();
  } catch {
    return null;
  }

  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }
  const [encodedPayload, signature] = parts;

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(encodedPayload)
    .digest('base64url');

  const sigBuffer = Buffer.from(signature);
  const expectedSigBuffer = Buffer.from(expectedSignature);

  if (sigBuffer.length !== expectedSigBuffer.length) {
    crypto.timingSafeEqual(expectedSigBuffer, expectedSigBuffer);
    return null;
  }

  if (!crypto.timingSafeEqual(sigBuffer, expectedSigBuffer)) {
    return null;
  }

  let payload: AccountLinkIntentPayload;
  try {
    payload = JSON.parse(base64UrlDecode(encodedPayload)) as AccountLinkIntentPayload;
  } catch {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (
    !payload?.userId ||
    !payload?.exp ||
    !payload?.iat ||
    payload.exp < now - CLOCK_SKEW_TOLERANCE_SECONDS ||
    payload.iat > now + CLOCK_SKEW_TOLERANCE_SECONDS
  ) {
    return null;
  }

  return { userId: payload.userId };
};

export const ACCOUNT_LINK_INTENT_COOKIE = 'account-link-intent';
