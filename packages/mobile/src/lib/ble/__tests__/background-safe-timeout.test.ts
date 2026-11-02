import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockRuntime = vi.hoisted(() => ({
  sessionPresenceNative: null as { delay?: (ms: number) => Promise<void> } | null,
}));

vi.mock('../../../../modules/live-activity/src/index', () => ({
  get sessionPresenceNative() {
    return mockRuntime.sessionPresenceNative;
  },
}));

import { setBackgroundSafeTimeout } from '../background-safe-timeout';

async function flushMicrotasks() {
  for (let tick = 0; tick < 5; tick++) {
    await Promise.resolve();
  }
}

// Fake timers that are never advanced stand in for Android's paused JS timers.
describe('setBackgroundSafeTimeout (#7038)', () => {
  let resolveNativeDelay: () => void = () => {};
  let nativeDelay: ReturnType<typeof vi.fn<(ms: number) => Promise<void>>>;

  beforeEach(() => {
    vi.useFakeTimers();
    nativeDelay = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveNativeDelay = resolve;
        }),
    );
    mockRuntime.sessionPresenceNative = { delay: nativeDelay };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires on the native clock when the JS timer never does', async () => {
    const callback = vi.fn();
    setBackgroundSafeTimeout(callback, 30_000);
    expect(nativeDelay).toHaveBeenCalledWith(30_000);

    resolveNativeDelay();
    await flushMicrotasks();
    expect(callback).toHaveBeenCalledOnce();
  });

  it('fires once when the JS timer lands first and the native one lands later', async () => {
    const callback = vi.fn();
    setBackgroundSafeTimeout(callback, 30_000);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(callback).toHaveBeenCalledOnce();

    resolveNativeDelay();
    await flushMicrotasks();
    expect(callback).toHaveBeenCalledOnce();
  });

  it('never fires once cancelled, whichever clock lands', async () => {
    const callback = vi.fn();
    const cancel = setBackgroundSafeTimeout(callback, 30_000);
    cancel();

    resolveNativeDelay();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(callback).not.toHaveBeenCalled();
  });

  it('keeps the JS timer in charge when the native delay rejects', async () => {
    nativeDelay.mockRejectedValue(new Error('module gone'));
    const callback = vi.fn();
    setBackgroundSafeTimeout(callback, 2_500);
    await flushMicrotasks();
    expect(callback).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_500);
    expect(callback).toHaveBeenCalledOnce();
  });

  it('uses the JS timer alone on a binary without the native delay', async () => {
    mockRuntime.sessionPresenceNative = {};
    const callback = vi.fn();
    setBackgroundSafeTimeout(callback, 2_500);

    await vi.advanceTimersByTimeAsync(2_500);
    expect(callback).toHaveBeenCalledOnce();
  });

  // SessionPresence is Android's module alone, so iOS reads null here.
  it('uses the JS timer alone on iOS, whose JS timers keep running', async () => {
    mockRuntime.sessionPresenceNative = null;
    const callback = vi.fn();
    setBackgroundSafeTimeout(callback, 2_500);

    await vi.advanceTimersByTimeAsync(2_500);
    expect(callback).toHaveBeenCalledOnce();
  });
});
