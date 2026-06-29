import { createHash } from 'node:crypto';
import { normalizeEmail } from '@boardsesh/db/utils';

export const PASSWORD_RESET_IDENTIFIER_PREFIX = 'password-reset:';

// Build the identifier from the canonicalised email so the value written in
// forgot-password and the value read in reset-password always agree, regardless
// of how the address was cased in the request or the reset link.
export function getPasswordResetIdentifier(email: string): string {
  return `${PASSWORD_RESET_IDENTIFIER_PREFIX}${normalizeEmail(email)}`;
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
