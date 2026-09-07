import { beforeEach, describe, expect, it, vi } from 'vitest';

const screenMock = vi.fn();
const registerForSessionMock = vi.fn();
const resetMock = vi.fn();
type FakeClient = {
  screen: typeof screenMock;
  registerForSession: typeof registerForSessionMock;
  reset: typeof resetMock;
  register: () => void;
  unregister: () => void;
};
let client: FakeClient | null = null;

vi.mock('../posthog-client', () => ({
  getPostHogClient: () => client,
  registerAppSuperProperties: vi.fn(),
}));

const shouldEmitScreenForSessionMock = vi.fn<(screenName: string) => boolean>(() => true);
vi.mock('../analytics-screen-session-gate', () => ({
  shouldEmitScreenForSession: (screenName: string) => shouldEmitScreenForSessionMock(screenName),
  resetScreenSessionGate: vi.fn(),
}));

import { trackScreen } from '../analytics';

beforeEach(() => {
  screenMock.mockClear();
  registerForSessionMock.mockClear();
  shouldEmitScreenForSessionMock.mockClear();
  shouldEmitScreenForSessionMock.mockReturnValue(true);
  resetMock.mockClear();
  client = {
    screen: screenMock,
    registerForSession: registerForSessionMock,
    reset: resetMock,
    register: () => {},
    unregister: () => {},
  };
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

describe('reset', () => {
  it('clears the screen gate, so a new sign-out path cannot forget it', async () => {
    // The gate is reset here rather than at each sign-out call site. This test is
    // the guard on that: it fails if the call moves back out of reset().
    const { reset } = await import('../analytics');
    const { resetScreenSessionGate } = await import('../analytics-screen-session-gate');

    reset();

    expect(vi.mocked(resetScreenSessionGate)).toHaveBeenCalled();
  });
});
