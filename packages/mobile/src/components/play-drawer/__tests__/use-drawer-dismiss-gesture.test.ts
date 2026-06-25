// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { SharedValue } from 'react-native-reanimated';

// The hook composes a reanimated worklet Pan — stub the native layers so it runs
// in node. These tests pin the axis-lock behaviour: while the carousel owns the
// gesture as a horizontal swipe (offset non-zero) or is settling a fling, the
// vertical dismiss must stand down, and a fast horizontal flick's vertical
// velocity must not sneak a dismiss through in onEnd.

vi.mock('react-native-reanimated', async () => {
  const { useRef } = await import('react');
  return {
    useSharedValue: (initial: unknown) => {
      const ref = useRef<{ value: unknown } | null>(null);
      if (ref.current === null) ref.current = { value: initial };
      return ref.current;
    },
    withSpring: (toValue: unknown) => toValue,
    runOnJS:
      (fn: (...args: unknown[]) => unknown) =>
      (...args: unknown[]) =>
        fn(...args),
  };
});

// Chainable Gesture.Pan() builder that records the worklet handlers for driving.
type RecordedHandlers = Record<string, (...args: unknown[]) => unknown>;
const recordedBuilders: { handlers: RecordedHandlers }[] = [];
vi.mock('react-native-gesture-handler', () => {
  const makeBuilder = () => {
    const handlers: RecordedHandlers = {};
    recordedBuilders.push({ handlers });
    const builder: Record<string, (...args: unknown[]) => unknown> = {};
    const proxy: typeof builder = new Proxy(builder, {
      get: (_target, prop: string) => {
        return (maybeHandler: unknown) => {
          if (typeof maybeHandler === 'function' && prop.startsWith('on')) {
            handlers[prop] = maybeHandler as RecordedHandlers[string];
          }
          return proxy;
        };
      },
    });
    return proxy;
  };
  return {
    Gesture: { Pan: () => makeBuilder() },
  };
});

import { useDrawerDismissGesture } from '../use-drawer-dismiss-gesture';

type Options = Parameters<typeof useDrawerDismissGesture>[0];

const onDismiss = vi.fn();

function sv<T>(value: T): SharedValue<T> {
  return { value } as unknown as SharedValue<T>;
}

function makeOptions(overrides: Partial<Options> = {}): Options {
  return {
    onDismiss,
    scrollYSV: sv(0),
    swipeTranslateX: sv(0),
    swipeIsAnimating: sv(false),
    ...overrides,
  };
}

function latestHandlers(): RecordedHandlers {
  const latest = recordedBuilders[recordedBuilders.length - 1];
  if (!latest) throw new Error('no Gesture.Pan() composed');
  return latest.handlers;
}

describe('useDrawerDismissGesture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recordedBuilders.length = 0;
  });

  it('follows a downward drag from the top when no horizontal swipe is active', () => {
    const { result } = renderHook((props: Options) => useDrawerDismissGesture(props), {
      initialProps: makeOptions(),
    });
    const handlers = latestHandlers();

    handlers.onBegin();
    handlers.onUpdate({ translationY: 50 });

    expect(result.current.translateY.value).toBe(50);
  });

  it('pins translateY to 0 while a horizontal swipe offset is non-zero', () => {
    const { result } = renderHook((props: Options) => useDrawerDismissGesture(props), {
      initialProps: makeOptions({ swipeTranslateX: sv(-40) }),
    });
    const handlers = latestHandlers();

    handlers.onBegin();
    handlers.onUpdate({ translationY: 50 });

    expect(result.current.translateY.value).toBe(0);
  });

  it('pins translateY to 0 while a fling is still settling', () => {
    const { result } = renderHook((props: Options) => useDrawerDismissGesture(props), {
      initialProps: makeOptions({ swipeIsAnimating: sv(true) }),
    });
    const handlers = latestHandlers();

    handlers.onBegin();
    handlers.onUpdate({ translationY: 50 });

    expect(result.current.translateY.value).toBe(0);
  });

  it('does not dismiss on a fast flick while a horizontal swipe is active, even past the velocity threshold', () => {
    const { result } = renderHook((props: Options) => useDrawerDismissGesture(props), {
      initialProps: makeOptions({ swipeTranslateX: sv(-40) }),
    });
    const handlers = latestHandlers();

    handlers.onBegin();
    // velocityY well past DISMISS_VELOCITY_THRESHOLD (600) — must still be blocked.
    handlers.onEnd({ velocityY: 1200 });

    expect(onDismiss).not.toHaveBeenCalled();
    expect(result.current.translateY.value).toBe(0);
  });

  it('does not dismiss on a fast flick while a fling is still settling, even past the velocity threshold', () => {
    // The velocity-sneak path must also be blocked by the animating flag alone:
    // the fresh re-touch during a settling fling never sets swipeTranslateX.
    const { result } = renderHook((props: Options) => useDrawerDismissGesture(props), {
      initialProps: makeOptions({ swipeIsAnimating: sv(true) }),
    });
    const handlers = latestHandlers();

    handlers.onBegin();
    handlers.onEnd({ velocityY: 1200 });

    expect(onDismiss).not.toHaveBeenCalled();
    expect(result.current.translateY.value).toBe(0);
  });

  it('dismisses on a committed downward drag when no horizontal swipe is active', () => {
    renderHook((props: Options) => useDrawerDismissGesture(props), {
      initialProps: makeOptions(),
    });
    const handlers = latestHandlers();

    handlers.onBegin();
    // Past DISMISS_DISTANCE_THRESHOLD (110) with the dismiss free to engage.
    handlers.onUpdate({ translationY: 150 });
    handlers.onEnd({ velocityY: 0 });

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
