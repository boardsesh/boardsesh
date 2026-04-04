import crypto from 'crypto';

const NATIVE_OAUTH_TRANSFER_TTL_SECONDS = 120;
const CLOCK_SKEW_TOLERANCE_SECONDS = 5;

type NativeOAuthTransferPayload = {
  userId: string;
  nextPath: string;
  iat: number;
  exp: number;
};

const base64UrlEncode = (value: string): string =>
  Buffer.from(value, 'utf8').toString('base64url');

const base64UrlDecode = (value: string): string =>
  Buffer.from(value, 'base64url').toString('utf8');

const getNativeOAuthSecret = (): string => {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error('NEXTAUTH_SECRET is required for native OAuth transfer flow');
  }
  return secret;
};

const sanitizeNextPath = (nextPath: string): string =>
  nextPath.startsWith('/') ? nextPath : '/';

export const issueNativeOAuthTransferToken = ({
  userId,
  nextPath,
}: {
  userId: string;
  nextPath: string;
}): string => {
  const now = Math.floor(Date.now() / 1000);
  const payload: NativeOAuthTransferPayload = {
    userId,
    nextPath: sanitizeNextPath(nextPath),
    iat: now,
    exp: now + NATIVE_OAUTH_TRANSFER_TTL_SECONDS,
  };

  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = crypto
    .createHmac('sha256', getNativeOAuthSecret())
    .update(encodedPayload)
    .digest('base64url');

  return `${encodedPayload}.${signature}`;
};

export const verifyNativeOAuthTransferToken = (
  token: string,
): { userId: string; nextPath: string } | null => {
  let secret: string;
  try {
    secret = getNativeOAuthSecret();
  } catch {
    return null;
  }

  const [encodedPayload, signature] = token.split('.');
  if (!encodedPayload || !signature) {
    return null;
  }

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(encodedPayload)
    .digest('base64url');

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

  return {
    userId: payload.userId,
    nextPath: sanitizeNextPath(payload.nextPath),
  };
};
