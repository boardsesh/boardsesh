import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppStateStatus } from 'react-native';
import { startForegroundWatchdog, type AppStateSource } from '../foreground-watchdog';

function fakeAppState(initialState: AppStateStatus) {
  const listeners = new Set<(state: AppStateStatus) => void>();
  const source: AppStateSource & { change: (state: AppStateStatus) => void; listenerCount: () => number } = {
    currentState: initialState,
    addEventListener: (_type, listener) => {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
    change(state) {
      source.currentState = state;
      for (const listener of listeners) listener(state);
    },
    listenerCount: () => listeners.size,
  };
  return source;
}

describe('startForegroundWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires once after the timeout of foreground time', () => {
    const onExpire = vi.fn();
    startForegroundWatchdog({ timeoutMs: 15_000, onExpire, appState: fakeAppState('active') });

    vi.advanceTimersByTime(14_999);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('pauses in the background and resumes with the time that was left', () => {
    const onExpire = vi.fn();
    const appState = fakeAppState('active');
    startForegroundWatchdog({ timeoutMs: 15_000, onExpire, appState });

    vi.advanceTimersByTime(10_000);
    appState.change('background');
    vi.advanceTimersByTime(120_000);
    expect(onExpire).not.toHaveBeenCalled();

    appState.change('active');
    vi.advanceTimersByTime(4_999);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('treats inactive (a system sheet over the app) as not foreground', () => {
    const onExpire = vi.fn();
    const appState = fakeAppState('active');
    startForegroundWatchdog({ timeoutMs: 15_000, onExpire, appState });

    appState.change('inactive');
    vi.advanceTimersByTime(30_000);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('does not start counting on a background launch until the app comes forward', () => {
    const onExpire = vi.fn();
    const appState = fakeAppState('background');
    startForegroundWatchdog({ timeoutMs: 15_000, onExpire, appState });

    vi.advanceTimersByTime(60_000);
    expect(onExpire).not.toHaveBeenCalled();

    appState.change('active');
    vi.advanceTimersByTime(15_000);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('never fires once stopped, and lets go of its listener', () => {
    const onExpire = vi.fn();
    const appState = fakeAppState('active');
    const stop = startForegroundWatchdog({ timeoutMs: 15_000, onExpire, appState });

    vi.advanceTimersByTime(5_000);
    stop();
    appState.change('background');
    appState.change('active');
    vi.advanceTimersByTime(60_000);

    expect(onExpire).not.toHaveBeenCalled();
    expect(appState.listenerCount()).toBe(0);
  });

  it('lets go of its listener after firing too', () => {
    const appState = fakeAppState('active');
    startForegroundWatchdog({ timeoutMs: 15_000, onExpire: vi.fn(), appState });

    vi.advanceTimersByTime(15_000);
    expect(appState.listenerCount()).toBe(0);
  });
});
