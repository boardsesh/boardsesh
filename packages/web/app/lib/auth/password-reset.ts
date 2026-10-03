import { createHash } from 'node:crypto';
export const PASSWORD_RESET_IDENTIFIER_PREFIX = 'password-reset:';
export const PASSWORD_RESET_USER_IDENTIFIER_PREFIX = `${PASSWORD_RESET_IDENTIFIER_PREFIX}v2:user:`;

// New tokens identify the account selected when the email is issued. Legacy
// email-only identifiers remain parseable so reset-password can accept them
// only when the email resolves to exactly one account.
export function getPasswordResetIdentifier(userId: string): string {
  return `${PASSWORD_RESET_USER_IDENTIFIER_PREFIX}${userId}`;
}

export function getPasswordResetUserId(identifier: string): string | null {
  if (!identifier.startsWith(PASSWORD_RESET_USER_IDENTIFIER_PREFIX)) return null;
  const userId = identifier.slice(PASSWORD_RESET_USER_IDENTIFIER_PREFIX.length);
  return userId || null;
}

export function getLegacyPasswordResetEmail(identifier: string): string | null {
  if (!identifier.startsWith(PASSWORD_RESET_IDENTIFIER_PREFIX)) return null;
  if (identifier.startsWith(PASSWORD_RESET_USER_IDENTIFIER_PREFIX)) return null;
  const email = identifier.slice(PASSWORD_RESET_IDENTIFIER_PREFIX.length);
  return email || null;
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
