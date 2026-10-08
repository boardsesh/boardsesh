// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import {
  FEATURE_FLAG_RESOLUTION_TIMEOUT_MS,
  FeatureFlagsProvider,
  type FeatureFlags,
} from '../../providers/feature-flags-provider';
import { resetObserveRuntimeForTests, setObserveRuntime } from '../../lib/observe-runtime';
import { useObserveRuntimeConfig } from '../use-observe-runtime-config';
import { updateConsentState } from '../../lib/consent-state';
import { grantAnalyticsForTest, grantedConsent } from '../../../test/consent-fixture';

const appStateMock = vi.hoisted(() => {
  type State = 'active' | 'background' | 'inactive' | 'unknown' | 'extension';
  type Listener = (state: State) => void;
  const listeners = new Set<Listener>();
  const state = { current: 'active' as State | null };
  const addEventListener = vi.fn((_event: 'change', listener: Listener) => {
    listeners.add(listener);
    return { remove: vi.fn(() => listeners.delete(listener)) };
  });

  return {
    addEventListener,
    emit(nextState: State) {
      state.current = nextState;
      for (const listener of listeners) listener(nextState);
    },
    listenerCount: () => listeners.size,
    reset() {
      state.current = 'active';
      listeners.clear();
      addEventListener.mockClear();
    },
    state,
  };
});

vi.mock('react-native', () => ({
  AppState: {
    addEventListener: appStateMock.addEventListener,
    get currentState() {
      return appStateMock.state.current;
    },
  },
}));

// Proves the flag → SDK wiring. The parsing rules themselves are
// observe-config.test.ts's contract; this file is about what actually reaches
// the SDK, including the case that matters most — flags that have not resolved.

afterEach(() => {
  cleanup();
  resetObserveRuntimeForTests();
  appStateMock.reset();
  vi.useRealTimers();
});

function wrapperFor(flags: FeatureFlags, staticFlagsAreFinal = true) {
  return ({ children }: { children: ReactNode }) => (
    <FeatureFlagsProvider flags={flags} staticFlagsAreFinal={staticFlagsAreFinal}>
      {children}
    </FeatureFlagsProvider>
  );
}

beforeEach(() => grantAnalyticsForTest());
function renderWithFlags(
  flags: FeatureFlags,
  staticFlagsAreFinal = true,
  discardPendingEvents = vi.fn(async (): Promise<void> => {}),
) {
  const configure = vi.fn();
  const dispatchEvents = vi.fn(async () => undefined);
  setObserveRuntime({ configure, dispatchEvents, discardPendingEvents, reportError: vi.fn() });
  const view = renderHook(() => useObserveRuntimeConfig(), { wrapper: wrapperFor(flags, staticFlagsAreFinal) });
  return { configure, dispatchEvents, discardPendingEvents, ...view };
}
async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('useObserveRuntimeConfig consent', () => {
  it('keeps unresolved or absent dispatch flags disabled, including after timeout', async () => {
    vi.useFakeTimers();
    const { configure, dispatchEvents } = renderWithFlags({}, false);
    expect(configure).toHaveBeenLastCalledWith({ dispatchingEnabled: false, sampleRate: 0 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FEATURE_FLAG_RESOLUTION_TIMEOUT_MS);
    });
    expect(dispatchEvents).not.toHaveBeenCalled();
    expect(configure).toHaveBeenLastCalledWith({ dispatchingEnabled: false, sampleRate: 0 });
  });
  it('waits for native buffer discard before enabling consented dispatch', async () => {
    let finishDiscard: (() => void) | undefined;
    const discard = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishDiscard = resolve;
        }),
    );
    const { configure, dispatchEvents } = renderWithFlags(
      { 'observe-dispatch-enabled': true, 'observe-sample-rate': '0.25' },
      true,
      discard,
    );
    expect(configure).toHaveBeenLastCalledWith({ dispatchingEnabled: false, sampleRate: 0 });
    expect(dispatchEvents).not.toHaveBeenCalled();
    finishDiscard?.();
    await settle();
    expect(configure).toHaveBeenLastCalledWith({ dispatchingEnabled: true, sampleRate: 0.25 });
    expect(dispatchEvents).toHaveBeenCalledOnce();
    expect(discard.mock.invocationCallOrder[0]).toBeLessThan(configure.mock.invocationCallOrder.at(-1)!);
  });
  it('fails closed if native discard is unavailable or fails', async () => {
    const { configure, dispatchEvents } = renderWithFlags(
      { 'observe-dispatch-enabled': true },
      true,
      vi.fn(async () => {
        throw new Error('unsupported');
      }),
    );
    await settle();
    expect(configure).toHaveBeenLastCalledWith({ dispatchingEnabled: false, sampleRate: 0 });
    expect(dispatchEvents).not.toHaveBeenCalled();
  });
  it('never enables dispatch for a denied choice, even with enabled flags', async () => {
    updateConsentState({ record: { ...grantedConsent, analytics: 'denied' } });
    const { configure, dispatchEvents } = renderWithFlags({ 'observe-dispatch-enabled': true });
    await settle();
    expect(configure).toHaveBeenLastCalledWith({ dispatchingEnabled: false, sampleRate: 0 });
    act(() => {
      appStateMock.emit('background');
      appStateMock.emit('active');
    });
    expect(dispatchEvents).not.toHaveBeenCalled();
  });
  it('withdrawal disables dispatch and drops foreground calls synchronously', async () => {
    const { configure, dispatchEvents } = renderWithFlags({ 'observe-dispatch-enabled': true });
    await settle();
    expect(dispatchEvents).toHaveBeenCalledOnce();
    act(() => updateConsentState({ record: { ...grantedConsent, analytics: 'denied' } }));
    await settle();
    expect(configure).toHaveBeenLastCalledWith({ dispatchingEnabled: false, sampleRate: 0 });
    act(() => {
      appStateMock.emit('background');
      appStateMock.emit('active');
    });
    expect(dispatchEvents).toHaveBeenCalledOnce();
  });
  it('flushes only when entering foreground and removes the listener on unmount', async () => {
    const { dispatchEvents, unmount } = renderWithFlags({ 'observe-dispatch-enabled': true });
    await settle();
    act(() => {
      appStateMock.emit('active');
      appStateMock.emit('inactive');
      appStateMock.emit('active');
      appStateMock.emit('active');
    });
    expect(dispatchEvents).toHaveBeenCalledTimes(2);
    expect(appStateMock.addEventListener).toHaveBeenCalledOnce();
    unmount();
    expect(appStateMock.listenerCount()).toBe(0);
  });
  it('cannot enable after the hook unmounts during discard', async () => {
    let finishDiscard: (() => void) | undefined;
    const { configure, dispatchEvents, unmount } = renderWithFlags(
      { 'observe-dispatch-enabled': true },
      true,
      vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishDiscard = resolve;
          }),
      ),
    );
    unmount();
    finishDiscard?.();
    await settle();
    expect(configure).toHaveBeenCalledOnce();
    expect(dispatchEvents).not.toHaveBeenCalled();
  });
});
