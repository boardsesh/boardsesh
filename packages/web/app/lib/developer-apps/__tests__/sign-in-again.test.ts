import { describe, expect, it } from 'vite-plus/test';
import { safeCallbackUrl } from '@/app/auth/signout/safe-callback-url';
import { applyLocale } from '@/app/lib/i18n/locale-href';
import { signInAgainPath } from '../sign-in-again';

/** Follows the two hops the way the sign-out and sign-in pages read them. */
function hops(href: string) {
  const signOut = new URL(href, 'https://www.boardsesh.com');
  const signIn = new URL(safeCallbackUrl(signOut.searchParams.get('callbackUrl')), 'https://www.boardsesh.com');
  const returnPath = safeCallbackUrl(signIn.searchParams.get('callbackUrl'), 'https://www.boardsesh.com');
  return { signOut: signOut.pathname, signIn: signIn.pathname, returnPath };
}

describe('signInAgainPath', () => {
  it('signs out, signs in again and comes back to the console', () => {
    expect(hops(applyLocale(signInAgainPath('en-US'), 'en-US'))).toEqual({
      signOut: '/auth/signout',
      signIn: '/auth/login',
      returnPath: '/developers/apps',
    });
  });

  it('stays in the developer’s language at every hop', () => {
    expect(hops(applyLocale(signInAgainPath('de'), 'de'))).toEqual({
      signOut: '/de/auth/signout',
      signIn: '/de/auth/login',
      returnPath: '/de/developers/apps',
    });
  });
});
