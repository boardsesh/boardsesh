// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { SharedValue } from 'react-native-reanimated';

// Issue #4279 (and #4191's unpaid gesture debt): on a zoomed board a downward
// drag pulled the play drawer away instead of panning the board. The z-order
// half of that was fixed by mounting the zoom-pan overlay above the board, but
// the drawer's pull-down-to-dismiss Pan sits on an ANCESTOR of the board, so
// RNGH still had two live candidates for the same one-finger downward drag —
// and z-order alone doesn't settle an ancestor/descendant race.
//
// This test wires the two hooks together the way PlayDrawer does and pins the
// relation end to end: the dismiss Pan tags itself with the ref it hands back,
// and the zoomed-only pan declares `blocksExternalGesture` against that exact
// ref, so while the board is zoomed the dismiss waits for the board's pan to
// fail.
//
// The other half matters just as much: the block must be ONE-DIRECTIONAL. The
// tempting symmetric fix — a `requireExternalGestureToFail` on the dismiss —
// would leave pull-to-dismiss waiting on a gesture that isn't even mounted when
// the board sits at 1x, so the drawer could never be pulled down again. The
// dismiss therefore declares no wait of its own; the carousel simply doesn't
// mount the zoom-pan detector unless zoomed (asserted in
// swipe-board-carousel-zoom-overlay.test.tsx).

vi.mock('react-native-reanimated', async () => {
  const { useRef } = await import('react');
  return {
    useSharedValue: (initial: unknown) => {
      const ref = useRef<{ value: unknown } | null>(null);
      if (ref.current === null) ref.current = { value: initial };
      return ref.current;
    },
    useAnimatedStyle: (factory: () => unknown) => factory(),
    withTiming: (toValue: unknown) => toValue,
    withSpring: (toValue: unknown) => toValue,
    cancelAnimation: () => {},
    runOnJS:
      (fn: (...args: unknown[]) => unknown) =>
      (...args: unknown[]) =>
        fn(...args),
  };
});

type RecordedBuilder = {
  kind: string;
  /** The chainable stand-in the hook returns, so a test can match by identity. */
  gesture: unknown;
  calls: Array<{ method: string; args: unknown[] }>;
};
const recordedBuilders: RecordedBuilder[] = [];

vi.mock('react-native-gesture-handler', () => {
  const makeBuilder = (kind: string) => {
    const calls: RecordedBuilder['calls'] = [];
    const proxy: Record<string, (...args: unknown[]) => unknown> = new Proxy(
      {},
      {
        get: (_target, method: string) => {
          return (...args: unknown[]) => {
            calls.push({ method, args });
            // RNGH populates a `withRef` ref when the detector initializes the
            // gesture; there's no detector here, so stand in for that and the
            // test can follow the ref back to the gesture that claimed it.
            if (method === 'withRef') {
              const ref = args[0] as { current?: unknown } | undefined;
              if (ref) ref.current = proxy;
            }
            return proxy;
          };
        },
      },
    );
    recordedBuilders.push({ kind, gesture: proxy, calls });
    return proxy;
  };
  return {
    Gesture: { Pinch: () => makeBuilder('Pinch'), Pan: () => makeBuilder('Pan') },
  };
});

import { useDrawerDismissGesture } from '../use-drawer-dismiss-gesture';
import { useZoomPanGesture } from '../use-zoom-pan-gesture';

function sv<T>(value: T): SharedValue<T> {
  return { value } as unknown as SharedValue<T>;
}

function builderOf(gesture: unknown): RecordedBuilder {
  const builder = recordedBuilders.find((recorded) => recorded.gesture === gesture);
  if (!builder) throw new Error('gesture was not composed through the mocked Gesture factory');
  return builder;
}

function relationsOf(gesture: unknown, method: string): unknown[] {
  return builderOf(gesture)
    .calls.filter((call) => call.method === method)
    .map((call) => call.args[0]);
}

/** The worklet the hook registered for a lifecycle callback, so a test can drive it. */
function handlerOf(gesture: unknown, method: string): (event?: unknown) => void {
  const call = builderOf(gesture).calls.find((recorded) => recorded.method === method);
  if (!call) throw new Error(`gesture registered no ${method} handler`);
  return call.args[0] as (event?: unknown) => void;
}

describe('zoomed board pan vs drawer pull-to-dismiss', () => {
  beforeEach(() => {
    recordedBuilders.length = 0;
  });

  it('makes the drawer dismiss wait on the zoomed board pan', () => {
    const { result: dismiss } = renderHook(() => useDrawerDismissGesture({ onDismiss: () => {}, scrollYSV: sv(0) }));
    const dismissRef = dismiss.current.gestureRef;

    // The dismiss Pan must have claimed the ref it hands out — an untagged ref
    // would leave the relation below pointing at nothing and still read green.
    expect(dismissRef.current).toBe(dismiss.current.gesture);

    const { result: zoom } = renderHook(() =>
      useZoomPanGesture({ containerWidth: 320, containerHeight: 480, dismissRef }),
    );

    // The board's zoomed-only pan blocks exactly that ref: RNGH makes the
    // dismiss wait for the board pan to fail instead of racing it.
    expect(relationsOf(zoom.current.zoomPanGesture, 'blocksExternalGesture')).toEqual([dismissRef]);
  });

  it('leaves the dismiss free to activate on its own — the wait is one-directional', () => {
    const { result: dismiss } = renderHook(() => useDrawerDismissGesture({ onDismiss: () => {}, scrollYSV: sv(0) }));
    renderHook(() =>
      useZoomPanGesture({ containerWidth: 320, containerHeight: 480, dismissRef: dismiss.current.gestureRef }),
    );

    // If the dismiss took the symmetric relation it would sit waiting on a pan
    // that only exists while zoomed, and an unzoomed pull-down would go dead.
    expect(relationsOf(dismiss.current.gesture, 'requireExternalGestureToFail')).toEqual([]);
    expect(relationsOf(dismiss.current.gesture, 'blocksExternalGesture')).toEqual([]);
  });

  it('still dismisses on an unzoomed downward drag once the ref has been handed out', () => {
    const onDismiss = vi.fn();
    const { result: dismiss } = renderHook(() => useDrawerDismissGesture({ onDismiss, scrollYSV: sv(0) }));
    renderHook(() =>
      useZoomPanGesture({ containerWidth: 320, containerHeight: 480, dismissRef: dismiss.current.gestureRef }),
    );

    handlerOf(dismiss.current.gesture, 'onBegin')();
    // Past DISMISS_DISTANCE_THRESHOLD (110), the board sitting at 1x.
    handlerOf(dismiss.current.gesture, 'onUpdate')({ translationY: 150 });
    handlerOf(dismiss.current.gesture, 'onEnd')({ velocityY: 0 });

    expect(dismiss.current.translateY.value).toBe(150);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('leaves the dismiss unblocked on boards that are not wired to it', () => {
    const { result: dismiss } = renderHook(() => useDrawerDismissGesture({ onDismiss: () => {}, scrollYSV: sv(0) }));
    const { result: zoom } = renderHook(() => useZoomPanGesture({ containerWidth: 320, containerHeight: 480 }));

    expect(relationsOf(zoom.current.zoomPanGesture, 'blocksExternalGesture')).toEqual([]);
    expect(dismiss.current.gestureRef.current).toBe(dismiss.current.gesture);
  });
});
