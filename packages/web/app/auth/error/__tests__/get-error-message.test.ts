import { describe, expect, it } from 'vite-plus/test';
import type { TFunction } from 'i18next';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import { getAuthErrorMessage, KNOWN_AUTH_ERROR_CODES } from '../get-error-message';

const t = ((key: string, options?: Record<string, unknown>) =>
  tFromCatalog('auth', key, options)) as unknown as TFunction<'auth'>;

const DEFAULT_COPY = 'An unexpected authentication error occurred.';

describe('getAuthErrorMessage', () => {
  it('returns the default copy when error is null', () => {
    expect(getAuthErrorMessage(null, t)).toBe(DEFAULT_COPY);
  });

  it('returns the default copy when error is undefined', () => {
    expect(getAuthErrorMessage(undefined, t)).toBe(DEFAULT_COPY);
  });

  it('returns the default copy when error is an empty string', () => {
    expect(getAuthErrorMessage('', t)).toBe(DEFAULT_COPY);
  });

  it('falls back to default for unknown codes (no template-key passthrough)', () => {
    expect(getAuthErrorMessage('NotARealErrorCode', t)).toBe(DEFAULT_COPY);
    expect(getAuthErrorMessage('<script>alert(1)</script>', t)).toBe(DEFAULT_COPY);
  });

  it('resolves each known error code to its catalog message', () => {
    const cases: Record<string, string> = {
      Configuration: 'There is a problem with the server configuration.',
      AccessDenied: 'Access denied. You do not have permission to sign in.',
      Verification: 'The verification link has expired or is invalid.',
      OAuthSignin: 'Error starting the sign-in flow. Please try again.',
      OAuthCallback: 'Error completing the sign-in. Please try again.',
      OAuthCreateAccount: 'Could not create an account with this provider.',
      OAuthEmailRequired:
        'This sign-in provider did not share an email address. Allow email access with the provider, then try again.',
      EmailCreateAccount: 'Could not create an email account.',
      Callback: 'Error in the authentication callback.',
      OAuthAccountNotLinked:
        'This email is already associated with another account. Please sign in using your original method.',
      SessionRequired: 'You must be signed in to access this page.',
    };

    for (const [code, expected] of Object.entries(cases)) {
      expect(getAuthErrorMessage(code, t)).toBe(expected);
    }
  });

  it('lists every known code in the cases above', () => {
    // Guards against silently dropping a code from the case table when
    // KNOWN_AUTH_ERROR_CODES grows.
    const expectedCodes = new Set([
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
    expect(new Set(KNOWN_AUTH_ERROR_CODES)).toEqual(expectedCodes);
  });
});
