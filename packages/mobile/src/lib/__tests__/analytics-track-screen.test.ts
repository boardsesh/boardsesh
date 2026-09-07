import { beforeEach, describe, expect, it, vi } from 'vitest';

const screenMock = vi.fn();
const registerForSessionMock = vi.fn();
let client: { screen: typeof screenMock; registerForSession: typeof registerForSessionMock } | null = null;

vi.mock('../posthog-client', () => ({
  getPostHogClient: () => client,
  registerAppSuperProperties: vi.fn(),
}));

const shouldEmitScreenForSessionMock = vi.fn<(screenName: string) => boolean>(() => true);
vi.mock('../analytics-screen-session-gate', () => ({
  shouldEmitScreenForSession: (screenName: string) => shouldEmitScreenForSessionMock(screenName),
}));

import { trackScreen } from '../analytics';

beforeEach(() => {
  screenMock.mockClear();
  registerForSessionMock.mockClear();
  shouldEmitScreenForSessionMock.mockClear();
  shouldEmitScreenForSessionMock.mockReturnValue(true);
  client = { screen: screenMock, registerForSession: registerForSessionMock };
});

describe('trackScreen', () => {
  it('captures $screen when the session gate allows it', () => {
    trackScreen('/climbs');

    expect(screenMock).toHaveBeenCalledExactlyOnceWith('/climbs');
  });

  it('does not capture $screen when the gate suppresses the screen', () => {
    shouldEmitScreenForSessionMock.mockReturnValue(false);

    trackScreen('/climbs');

    expect(screenMock).not.toHaveBeenCalled();
  });

  it('updates $screen_name on EVERY navigation, gated or not', () => {
    // The SDK stamps $screen_name onto every subsequent event, which is how
    // `Tick Logged` knows it happened on /play. If the suppressed path skipped
    // this, every other event would be attributed to whatever screen last got
    // past the gate, and the drift would worsen the longer a session ran.
    shouldEmitScreenForSessionMock.mockReturnValue(false);

    trackScreen('/play');

    expect(registerForSessionMock).toHaveBeenCalledExactlyOnceWith({ $screen_name: '/play' });
    expect(screenMock).not.toHaveBeenCalled();
  });

  it('updates $screen_name on the emitting path too', () => {
    trackScreen('/home');

    expect(registerForSessionMock).toHaveBeenCalledExactlyOnceWith({ $screen_name: '/home' });
    expect(screenMock).toHaveBeenCalledExactlyOnceWith('/home');
  });

  it('does nothing and does not throw when analytics is disabled', () => {
    client = null;

    expect(() => trackScreen('/home')).not.toThrow();
    expect(shouldEmitScreenForSessionMock).not.toHaveBeenCalled();
  });
});
