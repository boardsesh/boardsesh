// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import {
  FEATURE_FLAG_RESOLUTION_TIMEOUT_MS,
  FeatureFlagsProvider,
  type FeatureFlags,
} from '../../providers/feature-flags-provider';
import { resetObserveRuntimeForTests, setObserveRuntime } from '../../lib/observe-runtime';
import { useObserveRuntimeConfig } from '../use-observe-runtime-config';

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

function renderWithFlags(flags: FeatureFlags, staticFlagsAreFinal = true) {
  const configure = vi.fn();
  const dispatchEvents = vi.fn(async () => undefined);
  setObserveRuntime({ configure, dispatchEvents, reportError: vi.fn() });
  const view = renderHook(() => useObserveRuntimeConfig(), { wrapper: wrapperFor(flags, staticFlagsAreFinal) });
  return { configure, dispatchEvents, ...view };
}

describe('useObserveRuntimeConfig', () => {
  it('keeps full-rate configuration but waits to flush while flags are unresolved', () => {
    // The cold-start case, and the one that must not go quiet: a device that
    // never reaches PostHog has to keep reporting.
    const { configure, dispatchEvents } = renderWithFlags({}, false);

    expect(configure).toHaveBeenCalledWith({ dispatchingEnabled: true, sampleRate: 1 });
    expect(dispatchEvents).not.toHaveBeenCalled();
  });

  it('re-applies final configuration before the first foreground flush', () => {
    vi.useFakeTimers();
    const { configure, dispatchEvents } = renderWithFlags({}, false);

    act(() => {
      vi.advanceTimersByTime(FEATURE_FLAG_RESOLUTION_TIMEOUT_MS);
    });

    expect(configure).toHaveBeenCalledTimes(2);
    expect(dispatchEvents).toHaveBeenCalledOnce();
    expect(configure.mock.invocationCallOrder.at(-1)).toBeLessThan(dispatchEvents.mock.invocationCallOrder[0]);
  });

  it('applies the kill switch', () => {
    const { configure } = renderWithFlags({ 'observe-dispatch-enabled': false });

    expect(configure).toHaveBeenCalledWith(expect.objectContaining({ dispatchingEnabled: false }));
  });

  it('applies a sample rate from the multivariate flag', () => {
    const { configure } = renderWithFlags({ 'observe-sample-rate': '0.25' });

    expect(configure).toHaveBeenCalledWith(expect.objectContaining({ sampleRate: 0.25 }));
  });

  it('falls back to full sampling when the variant is unparseable', () => {
    // A typo in the dashboard must not reach the SDK as NaN and disable
    // collection for everyone who read the flag.
    const { configure } = renderWithFlags({ 'observe-sample-rate': 'half' });

    expect(configure).toHaveBeenCalledWith(expect.objectContaining({ sampleRate: 1 }));
  });

  it('does not re-apply on a re-render with unchanged flags', () => {
    // The effect deps are the two flag values, not the flags object, so an
    // unrelated re-render must not churn the SDK's config.
    const { configure, dispatchEvents, rerender } = renderWithFlags({ 'observe-sample-rate': '0.5' });
    expect(configure).toHaveBeenCalledTimes(1);
    expect(dispatchEvents).toHaveBeenCalledTimes(1);

    rerender();
    expect(configure).toHaveBeenCalledTimes(1);
    expect(dispatchEvents).toHaveBeenCalledTimes(1);
  });

  it('reconfigures changed flags without replacing the listener or flushing again', () => {
    let currentFlags: FeatureFlags = { 'observe-sample-rate': '0.5' };
    const configure = vi.fn();
    const dispatchEvents = vi.fn(async () => undefined);
    setObserveRuntime({ configure, dispatchEvents, reportError: vi.fn() });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <FeatureFlagsProvider flags={currentFlags} staticFlagsAreFinal>
        {children}
      </FeatureFlagsProvider>
    );
    const { rerender } = renderHook(() => useObserveRuntimeConfig(), { wrapper });

    currentFlags = { 'observe-dispatch-enabled': false, 'observe-sample-rate': '0.25' };
    rerender();

    expect(configure).toHaveBeenLastCalledWith({ dispatchingEnabled: false, sampleRate: 0.25 });
    expect(appStateMock.addEventListener).toHaveBeenCalledOnce();
    expect(appStateMock.listenerCount()).toBe(1);
    expect(dispatchEvents).toHaveBeenCalledOnce();
    act(() => appStateMock.emit('background'));
    act(() => appStateMock.emit('active'));
    expect(dispatchEvents).toHaveBeenCalledTimes(2);
  });

  it('flushes once per non-active to active transition', () => {
    const { dispatchEvents } = renderWithFlags({});
    expect(dispatchEvents).toHaveBeenCalledTimes(1);

    act(() => {
      appStateMock.emit('active');
      appStateMock.emit('active');
    });
    expect(dispatchEvents).toHaveBeenCalledTimes(1);

    act(() => {
      appStateMock.emit('background');
      appStateMock.emit('active');
      appStateMock.emit('active');
    });
    expect(dispatchEvents).toHaveBeenCalledTimes(2);

    act(() => {
      appStateMock.emit('inactive');
      appStateMock.emit('active');
    });
    expect(dispatchEvents).toHaveBeenCalledTimes(3);
  });

  it('waits for foreground when final flags resolve in the background', () => {
    appStateMock.state.current = 'background';
    const { dispatchEvents } = renderWithFlags({});
    expect(dispatchEvents).not.toHaveBeenCalled();

    act(() => appStateMock.emit('active'));
    expect(dispatchEvents).toHaveBeenCalledOnce();
  });

  it('flushes when an unknown initial app state first becomes active', () => {
    appStateMock.state.current = null;
    const { dispatchEvents } = renderWithFlags({});
    expect(dispatchEvents).not.toHaveBeenCalled();

    act(() => appStateMock.emit('active'));
    expect(dispatchEvents).toHaveBeenCalledOnce();
  });

  it('removes the app-state listener on unmount', () => {
    const { dispatchEvents, unmount } = renderWithFlags({});
    expect(appStateMock.listenerCount()).toBe(1);

    unmount();
    expect(appStateMock.listenerCount()).toBe(0);
    act(() => {
      appStateMock.emit('background');
      appStateMock.emit('active');
    });
    expect(dispatchEvents).toHaveBeenCalledTimes(1);
  });

  it('does not throw when no SDK is registered', () => {
    // Expo web and the node test runner never register one.
    expect(() => renderHook(() => useObserveRuntimeConfig(), { wrapper: wrapperFor({}) })).not.toThrow();
  });
});
