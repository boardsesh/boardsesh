export const EMAIL_VERIFICATION_USER_IDENTIFIER_PREFIX = 'email-verification:v2:user:';

export function getEmailVerificationTokenIdentifier(userId: string): string {
  return `${EMAIL_VERIFICATION_USER_IDENTIFIER_PREFIX}${userId}`;
}

export function getEmailVerificationTokenUserId(identifier: string): string | null {
  if (!identifier.startsWith(EMAIL_VERIFICATION_USER_IDENTIFIER_PREFIX)) return null;
  const userId = identifier.slice(EMAIL_VERIFICATION_USER_IDENTIFIER_PREFIX.length);
  return userId || null;
}
