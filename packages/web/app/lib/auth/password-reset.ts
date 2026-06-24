export const PASSWORD_RESET_IDENTIFIER_PREFIX = 'password-reset:';

export function getPasswordResetIdentifier(email: string): string {
  return `${PASSWORD_RESET_IDENTIFIER_PREFIX}${email}`;
}
