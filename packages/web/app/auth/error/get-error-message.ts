import type { TFunction } from 'i18next';

export const KNOWN_AUTH_ERROR_CODES: ReadonlySet<string> = new Set([
  'Configuration',
  'AccessDenied',
  'Verification',
  'OAuthSignin',
  'OAuthCallback',
  'OAuthCreateAccount',
  'OAuthEmailRequired',
  'EmailCreateAccount',
  'Callback',
  'OAuthAccountNotLinked',
  'SessionRequired',
]);

export function getAuthErrorMessage(error: string | null | undefined, t: TFunction<'auth'>): string {
  if (error && KNOWN_AUTH_ERROR_CODES.has(error)) {
    return t(`error.messages.${error}`);
  }
  return t('error.messages.default');
}
