import { createHash } from 'node:crypto';

export const PASSWORD_RESET_IDENTIFIER_PREFIX = 'password-reset:';

export function getPasswordResetIdentifier(email: string): string {
  return `${PASSWORD_RESET_IDENTIFIER_PREFIX}${email}`;
}

/** sha256(token) stored in DB; raw token travels only in the email link. */
export function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Pad response to a minimum duration to prevent timing-based enumeration. */
export async function consistentDelay(startTime: number, minMs: number): Promise<void> {
  const remaining = minMs - (Date.now() - startTime);
  if (remaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
}
