// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { OsAccessibilitySignals } from '../use-os-accessibility-signals';

type AppStateHandler = (state: string) => void;

const mocks = vi.hoisted(() => ({
  os: 'ios',
  appStateHandlers: [] as AppStateHandler[],
  isGrayscaleEnabled: vi.fn(async (): Promise<boolean> => false),
  isDarkerSystemColorsEnabled: vi.fn(async (): Promise<boolean> => false),
  isHighTextContrastEnabled: vi.fn(async (): Promise<boolean> => false),
  removeSubscription: vi.fn(),
  addEventListener: vi.fn((..._args: unknown[]) => ({ remove: mocks.removeSubscription })),
}));

vi.mock('react-native', () => ({
  AccessibilityInfo: {
    isGrayscaleEnabled: () => mocks.isGrayscaleEnabled(),
    isDarkerSystemColorsEnabled: () => mocks.isDarkerSystemColorsEnabled(),
    isHighTextContrastEnabled: () => mocks.isHighTextContrastEnabled(),
    addEventListener: (...args: unknown[]) => mocks.addEventListener(...args),
  },
  Platform: {
    get OS() {
      return mocks.os;
    },
  },
  AppState: {
    currentState: 'active',
    addEventListener: (_event: string, handler: AppStateHandler) => {
      mocks.appStateHandlers.push(handler);
      return {
        remove: () => {
          mocks.appStateHandlers = mocks.appStateHandlers.filter((entry) => entry !== handler);
        },
      };
    },
  },
}));

/**
 * The platform table is resolved once at module scope (that is the point — it is
 * a declared fact, not a per-render branch), so each platform needs a fresh
 * module graph.
 */
async function loadHook(os: 'ios' | 'android' | 'web'): Promise<() => OsAccessibilitySignals> {
  mocks.os = os;
  vi.resetModules();
  const module = await import('../use-os-accessibility-signals');
  return module.useOsAccessibilitySignals;
}

function eventNames(): string[] {
  return mocks.addEventListener.mock.calls.map((call) => String(call[0]));
}

function handlerFor(eventName: string): (enabled: boolean) => void {
  const call = mocks.addEventListener.mock.calls.find((entry) => entry[0] === eventName);
  if (!call) throw new Error(`No listener registered for ${eventName}`);
  return call[1] as (enabled: boolean) => void;
}

function sendAppState(state: 'background' | 'active'): void {
  for (const handler of mocks.appStateHandlers) handler(state);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.appStateHandlers = [];
  mocks.isGrayscaleEnabled.mockResolvedValue(false);
  mocks.isDarkerSystemColorsEnabled.mockResolvedValue(false);
  mocks.isHighTextContrastEnabled.mockResolvedValue(false);
  mocks.addEventListener.mockReturnValue({ remove: mocks.removeSubscription });
});

describe('useOsAccessibilitySignals', () => {
  it('starts unknown and not ready, the opposite posture to the other accessibility hooks', async () => {
    // The sibling hooks default to a conservative `true` because being wrong
    // costs one frame of glass. Being wrong here costs an unwanted banner, so
    // nothing is known until it has actually been read.
    mocks.isGrayscaleEnabled.mockReturnValue(new Promise<boolean>(() => {}));
    mocks.isDarkerSystemColorsEnabled.mockReturnValue(new Promise<boolean>(() => {}));
    const useSignals = await loadHook('ios');

    const { result } = renderHook(() => useSignals());

    expect(result.current).toEqual({ increaseContrast: 'unknown', grayscale: 'unknown', ready: false });
  });

  it('maps a resolved false to `off` and settles', async () => {
    const useSignals = await loadHook('ios');

    const { result } = renderHook(() => useSignals());

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.increaseContrast).toBe('off');
    expect(result.current.grayscale).toBe('off');
  });

  it('maps a resolved true to `on`', async () => {
    mocks.isGrayscaleEnabled.mockResolvedValue(true);
    const useSignals = await loadHook('ios');

    const { result } = renderHook(() => useSignals());

    await waitFor(() => expect(result.current.grayscale).toBe('on'));
  });

  it('lands a REJECTED query on `unknown`, never on `off`', async () => {
    // A missing native method (Android) or an older binary running a newer JS
    // bundle (iOS) rejects. Reading that as "the climber has it off" would be a
    // guess dressed up as a reading.
    mocks.isGrayscaleEnabled.mockRejectedValue(new Error('not available'));
    const useSignals = await loadHook('ios');

    const { result } = renderHook(() => useSignals());

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.grayscale).toBe('unknown');
    expect(result.current.increaseContrast).toBe('off');
  });

  it('never asks a query the platform hardcodes false, and leaves that signal unknown', async () => {
    // Android's `isDarkerSystemColorsEnabled` resolves a hardcoded `false`, so
    // asking would manufacture an "off" reading out of nothing.
    const useSignals = await loadHook('android');

    const { result } = renderHook(() => useSignals());

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(mocks.isDarkerSystemColorsEnabled).not.toHaveBeenCalled();
    expect(mocks.isHighTextContrastEnabled).toHaveBeenCalled();
  });

  it('settles immediately with everything unknown on a platform with no queries at all', async () => {
    const useSignals = await loadHook('web');

    const { result } = renderHook(() => useSignals());

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current).toEqual({ increaseContrast: 'unknown', grayscale: 'unknown', ready: true });
    expect(mocks.isGrayscaleEnabled).not.toHaveBeenCalled();
    expect(mocks.addEventListener).not.toHaveBeenCalled();
  });

  it('subscribes only to event names the running platform maps', async () => {
    // An unmapped name returns a silent no-op subscription that looks alive
    // forever and never fires, so a wrong name here would be invisible.
    const useSignalsIos = await loadHook('ios');
    renderHook(() => useSignalsIos());
    expect(eventNames().sort()).toEqual(['darkerSystemColorsChanged', 'grayscaleChanged']);

    mocks.addEventListener.mockClear();

    const useSignalsAndroid = await loadHook('android');
    renderHook(() => useSignalsAndroid());
    expect(eventNames().sort()).toEqual(['grayscaleChanged', 'highTextContrastChanged']);
  });

  it('updates when a change event fires', async () => {
    const useSignals = await loadHook('ios');
    const { result } = renderHook(() => useSignals());
    await waitFor(() => expect(result.current.ready).toBe(true));

    act(() => handlerFor('grayscaleChanged')(true));

    expect(result.current.grayscale).toBe('on');
  });

  it('unsubscribes every listener on unmount', async () => {
    const useSignals = await loadHook('ios');
    const { unmount } = renderHook(() => useSignals());

    unmount();

    expect(mocks.removeSubscription).toHaveBeenCalledTimes(2);
  });

  it('re-polls when the app comes back to the foreground', async () => {
    // The realistic flow: leave for Settings, flip the toggle, come back.
    const useSignals = await loadHook('ios');
    const { result } = renderHook(() => useSignals());
    await waitFor(() => expect(result.current.grayscale).toBe('off'));

    mocks.isGrayscaleEnabled.mockResolvedValue(true);
    // Two renders, as the OS delivers them: the backgrounded flag has to be
    // observed as `true` before it can fall back to `false` — that edge is the
    // re-poll trigger.
    act(() => sendAppState('background'));
    act(() => sendAppState('active'));

    await waitFor(() => expect(result.current.grayscale).toBe('on'));
  });

  it('does not re-poll while the app stays in the foreground', async () => {
    const useSignals = await loadHook('ios');
    const { result, rerender } = renderHook(() => useSignals());
    await waitFor(() => expect(result.current.ready).toBe(true));
    const callsAfterFirstRead = mocks.isGrayscaleEnabled.mock.calls.length;

    rerender();

    expect(mocks.isGrayscaleEnabled).toHaveBeenCalledTimes(callsAfterFirstRead);
  });
});
