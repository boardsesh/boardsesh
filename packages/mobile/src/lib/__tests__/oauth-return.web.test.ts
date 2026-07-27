// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { consumeWebOAuthReturnProvider } from '../oauth-return.web';

afterEach(() => {
  window.history.replaceState({}, '', '/');
});

describe('consumeWebOAuthReturnProvider', () => {
  it('returns a valid provider and removes only the one-time marker', () => {
    window.history.replaceState({}, '', '/app?boardseshOAuthProvider=google&keep=1');

    expect(consumeWebOAuthReturnProvider()).toBe('google');
    expect(window.location.pathname).toBe('/app');
    expect(window.location.search).toBe('?keep=1');
    expect(consumeWebOAuthReturnProvider()).toBeNull();
  });

  it('removes an invalid provider marker without attributing a login', () => {
    window.history.replaceState({}, '', '/?boardseshOAuthProvider=facebook');

    expect(consumeWebOAuthReturnProvider()).toBeNull();
    expect(window.location.search).toBe('');
  });
});
