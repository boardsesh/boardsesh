// Sign-in from inside the board picker replaces the picker rather than being
// pushed on top of it: `auth` has no presentation, so a push over the picker's
// modal is presented as a second sheet, with its swipe turned off.
import { describe, expect, it, vi } from 'vitest';
import { SIGN_IN_HREF, openSignIn } from '../open-sign-in';

function fakeRouter() {
  return { push: vi.fn(), dismissTo: vi.fn() };
}

describe('openSignIn', () => {
  it('puts sign-in in place of the picker from inside it', () => {
    const router = fakeRouter();
    openSignIn(router, 'boards');
    expect(router.dismissTo).toHaveBeenCalledExactlyOnceWith('/auth/login');
    expect(router.push).not.toHaveBeenCalled();
  });

  it('pushes it as before everywhere else', () => {
    const router = fakeRouter();
    openSignIn(router, 'root');
    expect(router.push).toHaveBeenCalledExactlyOnceWith(SIGN_IN_HREF);
    expect(router.dismissTo).not.toHaveBeenCalled();
  });
});
