// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { SWIPE_THRESHOLD } from '@boardsesh/play-view';

// The hook composes a reanimated worklet gesture — stub the native layers so it
// runs in node. What these tests are really about: the Pan gesture composes
// ONCE per mount (recomposing mid-session left RNGH stuck on iOS), with
// canSwipeNext/canSwipePrevious read through shared values so boundary flips
// don't rebuild it but still gate the worklet handlers.

// Mirror reanimated's contract: useSharedValue returns the SAME mutable ref
// across re-renders; animations resolve to their target value synchronously.
vi.mock('react-native-reanimated', async () => {
  const { useRef } = await import('react');
  return {
    useSharedValue: (initial: unknown) => {
      const ref = useRef<{ value: unknown } | null>(null);
      if (ref.current === null) ref.current = { value: initial };
      return ref.current;
    },
    withTiming: (toValue: unknown) => toValue,
    withSpring: (toValue: unknown) => toValue,
    runOnJS:
      (fn: (...args: unknown[]) => unknown) =>
      (...args: unknown[]) =>
        fn(...args),
  };
});

// Chainable Gesture.Pan() builder that is FRESH per call (so gesture identity
// assertions are meaningful) and records the worklet handlers for driving.
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

vi.mock('../../../lib/haptics', () => ({ hapticMedium: vi.fn() }));

import { useCarouselGesture } from '../use-carousel-gesture';

type Options = Parameters<typeof useCarouselGesture>[0];

const onSwipeNext = vi.fn();
const onSwipePrevious = vi.fn();

function makeOptions(overrides: Partial<Options> = {}): Options {
  return {
    onSwipeNext,
    onSwipePrevious,
    canSwipeNext: true,
    canSwipePrevious: true,
    boardWidth: 320,
    ...overrides,
  };
}

function latestHandlers(): RecordedHandlers {
  const latest = recordedBuilders[recordedBuilders.length - 1];
  if (!latest) throw new Error('no Gesture.Pan() composed');
  return latest.handlers;
}

describe('useCarouselGesture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recordedBuilders.length = 0;
  });

  it('keeps the gesture identity stable across swipe-availability, enabled, and board-width changes', () => {
    const { result, rerender } = renderHook((props: Options) => useCarouselGesture(props), {
      initialProps: makeOptions(),
    });

    const firstGesture = result.current.gesture;

    rerender(makeOptions({ canSwipeNext: false, canSwipePrevious: false, enabled: false, boardWidth: 280 }));
    rerender(makeOptions({ canSwipeNext: true, canSwipePrevious: false, reduceMotion: true }));

    expect(result.current.gesture).toBe(firstGesture);
    // One composition total — recomposing mid-session is the iOS RNGH wedge.
    expect(recordedBuilders).toHaveLength(1);
  });

  it('onEnd commits per the LATEST canSwipeNext, not the value captured at composition', () => {
    const { result, rerender } = renderHook((props: Options) => useCarouselGesture(props), {
      // reduceMotion keeps the commit synchronous (no slide-off timer).
      initialProps: makeOptions({ reduceMotion: true }),
    });
    const handlers = latestHandlers();

    result.current.translateX.value = -(SWIPE_THRESHOLD + 1);
    handlers.onEnd();
    expect(onSwipeNext).toHaveBeenCalledTimes(1);

    rerender(makeOptions({ reduceMotion: true, canSwipeNext: false }));
    result.current.translateX.value = -(SWIPE_THRESHOLD + 1);
    handlers.onEnd();
    expect(onSwipeNext).toHaveBeenCalledTimes(1);
  });

  it('onUpdate clamps the drag once canSwipeNext flips false', () => {
    const { result, rerender } = renderHook((props: Options) => useCarouselGesture(props), {
      initialProps: makeOptions(),
    });
    const handlers = latestHandlers();

    handlers.onUpdate({ translationX: -50 });
    expect(result.current.translateX.value).toBe(-50);

    rerender(makeOptions({ canSwipeNext: false }));
    handlers.onUpdate({ translationX: -50 });
    expect(result.current.translateX.value).toBe(0);
  });

  it('onEnd springs back without committing below the threshold', () => {
    const { result } = renderHook((props: Options) => useCarouselGesture(props), {
      initialProps: makeOptions({ reduceMotion: true }),
    });
    const handlers = latestHandlers();

    result.current.translateX.value = -(SWIPE_THRESHOLD - 1);
    handlers.onEnd();

    expect(onSwipeNext).not.toHaveBeenCalled();
    expect(onSwipePrevious).not.toHaveBeenCalled();
    expect(result.current.translateX.value).toBe(0);
  });
});
