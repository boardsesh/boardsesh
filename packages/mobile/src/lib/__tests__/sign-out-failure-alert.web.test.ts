// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { showSignOutFailure } from '../sign-out-failure-alert.web';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('web sign-out failure alert', () => {
  it('uses the browser dialog that remains visible after the auth tree unmounts', () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});

    showSignOutFailure('Sign-out was not confirmed', 'Reconnect and sign out again');

    expect(alertSpy).toHaveBeenCalledWith('Sign-out was not confirmed\n\nReconnect and sign out again');
  });
});
