// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { consumeWebOAuthReturn } from '../oauth-return.web';

afterEach(() => {
  window.history.replaceState({}, '', '/');
});

describe('consumeWebOAuthReturn', () => {
  it('returns a valid provider and removes only the one-time marker', () => {
    window.history.replaceState(
      {},
      '',
      '/app/auth/login?boardseshOAuthProvider=google&boardseshOAuthAttempt=attempt-google-1&keep=1',
    );

    expect(consumeWebOAuthReturn()).toEqual({
      provider: 'google',
      attemptId: 'attempt-google-1',
      error: null,
    });
    expect(window.location.pathname).toBe('/app/auth/login');
    expect(window.location.search).toBe('?keep=1');
    expect(consumeWebOAuthReturn()).toBeNull();
  });

  it('removes an invalid provider marker without attributing a login', () => {
    window.history.replaceState({}, '', '/?boardseshOAuthProvider=facebook');

    expect(consumeWebOAuthReturn()).toBeNull();
    expect(window.location.search).toBe('');
  });

  it('returns a provider failure to the initiating attempt', () => {
    window.history.replaceState(
      {},
      '',
      '/auth/register?boardseshOAuthProvider=apple&boardseshOAuthAttempt=attempt-apple-1&boardseshOAuthError=OAuthCallback',
    );

    expect(consumeWebOAuthReturn()).toEqual({
      provider: 'apple',
      attemptId: 'attempt-apple-1',
      error: 'OAuthCallback',
    });
    expect(window.location.search).toBe('');
  });
});
