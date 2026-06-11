import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TokenRegistrationFn, TokenUnregistrationFn } from '../token-manager';

const mockGetDevicePushToken = vi.fn<() => Promise<string | null>>();
const mockRemove = vi.fn();
const mockAddPushTokenListener = vi.fn(() => ({ remove: mockRemove }));

vi.mock('../setup', () => ({
  getDevicePushToken: mockGetDevicePushToken,
  addPushTokenListener: mockAddPushTokenListener,
}));

async function loadModule() {
  const mod = await import('../token-manager');
  return mod;
}

describe('token-manager', () => {
  let startTokenManagement: (sessionId: string, register: TokenRegistrationFn) => Promise<void>;
  let stopTokenManagement: (unregister: TokenUnregistrationFn) => Promise<void>;
  let getCurrentToken: () => string | null;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.clearAllMocks();

    const mod = await loadModule();
    startTokenManagement = mod.startTokenManagement;
    stopTokenManagement = mod.stopTokenManagement;
    getCurrentToken = mod.getCurrentToken;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers token on start', async () => {
    mockGetDevicePushToken.mockResolvedValue('abc123');
    const register = vi.fn<TokenRegistrationFn>().mockResolvedValue(undefined);

    await startTokenManagement('session-1', register);

    expect(register).toHaveBeenCalledWith('session-1', 'abc123');
    expect(register).toHaveBeenCalledTimes(1);
  });

  it('does nothing when no device token', async () => {
    mockGetDevicePushToken.mockResolvedValue(null);
    const register = vi.fn<TokenRegistrationFn>().mockResolvedValue(undefined);

    await startTokenManagement('session-1', register);

    expect(register).not.toHaveBeenCalled();
  });

  it('retries registration on failure', async () => {
    mockGetDevicePushToken.mockResolvedValue('abc123');
    const register = vi
      .fn<TokenRegistrationFn>()
      .mockRejectedValueOnce(new Error('fail'))
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce(undefined);

    const promise = startTokenManagement('session-1', register);
    await vi.runAllTimersAsync();
    await promise;

    expect(register).toHaveBeenCalledTimes(3);
    expect(register).toHaveBeenCalledWith('session-1', 'abc123');
  });

  it('gives up after all retry attempts fail', async () => {
    mockGetDevicePushToken.mockResolvedValue('abc123');
    const register = vi.fn<TokenRegistrationFn>().mockRejectedValue(new Error('always fails'));

    const promise = startTokenManagement('session-1', register);
    await vi.runAllTimersAsync();
    await promise;

    expect(register).toHaveBeenCalledTimes(5);
  });

  it('applies jitter to retry delays (no thundering herd)', async () => {
    mockGetDevicePushToken.mockResolvedValue('abc123');
    // First call fails so we schedule the second attempt (base delay 2000ms),
    // then succeeds.
    const register = vi
      .fn<TokenRegistrationFn>()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce(undefined);

    // Math.random() === 1 maps to the top of the ±20% band: 2000 * 1.2 = 2400.
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(1);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const promise = startTokenManagement('session-1', register);
    await vi.runAllTimersAsync();
    await promise;

    const scheduledDelays = setTimeoutSpy.mock.calls.map((call) => call[1]);
    // The 2000ms retry must have been jittered above its base, never left bare.
    expect(scheduledDelays).toContain(2400);
    expect(scheduledDelays).not.toContain(2000);

    randomSpy.mockRestore();
    setTimeoutSpy.mockRestore();
  });

  it('keeps the first attempt immediate (zero base stays zero under jitter)', async () => {
    mockGetDevicePushToken.mockResolvedValue('abc123');
    const register = vi.fn<TokenRegistrationFn>().mockResolvedValue(undefined);

    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    await startTokenManagement('session-1', register);

    // First attempt has base delay 0 — it must not schedule any timer.
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(register).toHaveBeenCalledTimes(1);

    setTimeoutSpy.mockRestore();
  });

  it('re-registers on token refresh', async () => {
    mockGetDevicePushToken.mockResolvedValue('abc123');
    const register = vi.fn<TokenRegistrationFn>().mockResolvedValue(undefined);

    await startTokenManagement('session-1', register);

    const refreshCallback = (mockAddPushTokenListener.mock.calls[0] as unknown[])[0] as (
      token: string,
    ) => Promise<void>;
    const refreshPromise = refreshCallback('new-token-456');
    await vi.runAllTimersAsync();
    await refreshPromise;

    expect(register).toHaveBeenCalledTimes(2);
    expect(register).toHaveBeenCalledWith('session-1', 'new-token-456');
  });

  it('unregisters on stop', async () => {
    mockGetDevicePushToken.mockResolvedValue('abc123');
    const register = vi.fn<TokenRegistrationFn>().mockResolvedValue(undefined);
    const unregister = vi.fn<TokenUnregistrationFn>().mockResolvedValue(undefined);

    await startTokenManagement('session-1', register);
    await stopTokenManagement(unregister);

    expect(unregister).toHaveBeenCalledWith('session-1', 'abc123');
  });

  it('stop is best-effort', async () => {
    mockGetDevicePushToken.mockResolvedValue('abc123');
    const register = vi.fn<TokenRegistrationFn>().mockResolvedValue(undefined);
    const unregister = vi.fn<TokenUnregistrationFn>().mockRejectedValue(new Error('network error'));

    await startTokenManagement('session-1', register);
    await expect(stopTokenManagement(unregister)).resolves.toBeUndefined();
  });

  it('getCurrentToken returns current token', async () => {
    mockGetDevicePushToken.mockResolvedValue('abc123');
    const register = vi.fn<TokenRegistrationFn>().mockResolvedValue(undefined);

    await startTokenManagement('session-1', register);

    expect(getCurrentToken()).toBe('abc123');
  });

  it('getCurrentToken returns null after stop', async () => {
    mockGetDevicePushToken.mockResolvedValue('abc123');
    const register = vi.fn<TokenRegistrationFn>().mockResolvedValue(undefined);
    const unregister = vi.fn<TokenUnregistrationFn>().mockResolvedValue(undefined);

    await startTokenManagement('session-1', register);
    await stopTokenManagement(unregister);

    expect(getCurrentToken()).toBeNull();
  });

  it('removes listener on stop', async () => {
    mockGetDevicePushToken.mockResolvedValue('abc123');
    const register = vi.fn<TokenRegistrationFn>().mockResolvedValue(undefined);
    const unregister = vi.fn<TokenUnregistrationFn>().mockResolvedValue(undefined);

    await startTokenManagement('session-1', register);
    await stopTokenManagement(unregister);

    expect(mockRemove).toHaveBeenCalled();
  });

  it('replaces listener on re-start', async () => {
    mockGetDevicePushToken.mockResolvedValue('token-1');
    const register = vi.fn<TokenRegistrationFn>().mockResolvedValue(undefined);

    await startTokenManagement('session-1', register);

    const firstRemove = mockRemove;
    expect(firstRemove).not.toHaveBeenCalled();

    mockGetDevicePushToken.mockResolvedValue('token-2');
    const secondRemove = vi.fn();
    mockAddPushTokenListener.mockReturnValueOnce({ remove: secondRemove });

    await startTokenManagement('session-2', register);

    expect(firstRemove).toHaveBeenCalled();
    expect(register).toHaveBeenCalledWith('session-2', 'token-2');
  });
});
