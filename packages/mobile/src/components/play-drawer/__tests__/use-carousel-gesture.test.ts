// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { SWIPE_OFFSCREEN_PAD, SWIPE_THRESHOLD } from '@boardsesh/play-view';

const platform = vi.hoisted(() => ({ OS: 'ios' }));
vi.mock('react-native', () => ({ Platform: platform }));

// The hook composes a reanimated worklet gesture — stub the native layers so it
// runs in node. What these tests are really about: the Pan gesture composes
// ONCE per mount (recomposing mid-session left RNGH stuck on iOS); which page is
// in the middle is settled by the worklets, from the pager's shared values,
// without waiting for the JS thread; and a swipe that starts while the last
// fling is still running takes it over instead of being ignored.

const springCallbacks = vi.hoisted(() => [] as ((finished: boolean) => void)[]);
// The hook's one reaction: has the incoming board stopped in the middle yet.
const stoppedReaction = vi.hoisted(() => ({
  prepare: null as null | (() => boolean),
  react: null as null | ((now: boolean, before: boolean | null) => void),
  before: null as boolean | null,
}));

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
    useAnimatedReaction: (prepare: () => boolean, react: (now: boolean, before: boolean | null) => void) => {
      stoppedReaction.prepare = prepare;
      stoppedReaction.react = react;
    },
    withTiming: (toValue: unknown) => toValue,
    // Resolves to its target at once, like the rest of this mock, and hands the
    // completion callback to the test, which decides when the fling lands.
    withSpring: (toValue: unknown, _config?: unknown, onFinished?: (finished: boolean) => void) => {
      if (onFinished) springCallbacks.push(onFinished);
      return toValue;
    },
    runOnJS:
      (fn: (...args: unknown[]) => unknown) =>
      (...args: unknown[]) =>
        fn(...args),
  };
});

// Chainable Gesture.Pan() builder that is FRESH per call (so gesture identity
// assertions are meaningful) and records the worklet handlers for driving.
type RecordedHandlers = Record<string, (...args: unknown[]) => unknown>;
const recordedBuilders: { handlers: RecordedHandlers; settings: Record<string, unknown> }[] = [];
vi.mock('react-native-gesture-handler', () => {
  const makeBuilder = () => {
    const handlers: RecordedHandlers = {};
    const settings: Record<string, unknown> = {};
    recordedBuilders.push({ handlers, settings });
    const builder: Record<string, (...args: unknown[]) => unknown> = {};
    const proxy: typeof builder = new Proxy(builder, {
      get: (_target, prop: string) => {
        return (maybeHandler: unknown) => {
          if (typeof maybeHandler === 'function' && prop.startsWith('on')) {
            handlers[prop] = maybeHandler as RecordedHandlers[string];
          } else {
            settings[prop] = maybeHandler;
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
import type { SwipePager, SwipePagerJsState } from '../use-swipe-pager';

type Options = Parameters<typeof useCarouselGesture>[0];

const onSwipeNext = vi.fn();
const onSwipePrevious = vi.fn();
const BOARD_WIDTH = 320;
const SCREEN_WIDTH = 390;
const FLING_TARGET = SCREEN_WIDTH + SWIPE_OFFSCREEN_PAD;

function shared<Value>(value: Value) {
  return { value } as unknown as SwipePager['translateX'] & { value: Value };
}

/** A pager whose JS side has rendered page 0 with a neighbour each side. */
function makePager(state: Partial<SwipePagerJsState> = {}) {
  return {
    translateX: shared(0),
    isAnimating: shared(false),
    anchorPage: shared(0),
    flingDirection: shared(0),
    uiSteps: shared(0),
    jsState: shared<SwipePagerJsState>({ center: 0, hasPrevious: true, hasNext: true, processedStep: 0, ...state }),
    slideWidth: shared(0),
    resetGeneration: shared(0),
    // The real pager runs a step's navigation when its turn comes; with nothing
    // ahead of it, that is at once.
    requestStep: vi.fn((_direction: 1 | -1, _step: number, navigate: () => void) => navigate()),
    stepRendered: vi.fn(),
  } as unknown as SwipePager & { requestStep: ReturnType<typeof vi.fn> };
}

function makeOptions(overrides: Partial<Options> = {}): Options {
  return {
    pager: makePager(),
    onSwipeNext,
    onSwipePrevious,
    boardWidth: BOARD_WIDTH,
    screenWidth: SCREEN_WIDTH,
    ...overrides,
  };
}

function latestHandlers(): RecordedHandlers {
  const latest = recordedBuilders[recordedBuilders.length - 1];
  if (!latest) throw new Error('no Gesture.Pan() composed');
  return latest.handlers;
}

/** A drag from rest that is let go: `translationX` of finger travel at `velocityX`. */
function swipe(handlers: RecordedHandlers, translationX: number, velocityX = 0) {
  handlers.onStart({ translationX: 0 });
  handlers.onUpdate({ translationX });
  handlers.onEnd({ translationX, velocityX });
}

function landFling() {
  const onFinished = springCallbacks.pop();
  if (!onFinished) throw new Error('no fling is running');
  onFinished(true);
}

/** Run the reaction the way Reanimated does after a frame in which its inputs changed. */
function runStoppedReaction() {
  const { prepare, react } = stoppedReaction;
  if (!prepare || !react) throw new Error('the hook registered no reaction');
  const now = prepare();
  react(now, stoppedReaction.before);
  stoppedReaction.before = now;
}

/** Put the outgoing board `offset` along its fling: the mock jumps straight to the fling's target. */
function flingReaches(pager: ReturnType<typeof makePager>, offset: number) {
  pager.translateX.value = offset;
  runStoppedReaction();
}

describe('useCarouselGesture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recordedBuilders.length = 0;
    springCallbacks.length = 0;
    stoppedReaction.before = null;
    platform.OS = 'ios';
  });

  it.each(['ios', 'android'])('allows %s scrolling simultaneously with the carousel', (platformName) => {
    platform.OS = platformName;
    const scrollRef = { current: null };
    renderHook(() => useCarouselGesture(makeOptions({ scrollRef })));
    const settings = recordedBuilders[0].settings;
    expect(settings.simultaneousWithExternalGesture).toBe(scrollRef);
    expect(settings.blocksExternalGesture).toBeUndefined();
    expect(settings.maxPointers).toBe(1);
  });

  it('retains simultaneous browser scrolling', () => {
    platform.OS = 'web';
    const scrollRef = { current: null };
    renderHook(() => useCarouselGesture(makeOptions({ scrollRef })));
    const settings = recordedBuilders[0].settings;
    expect(settings.simultaneousWithExternalGesture).toBe(scrollRef);
    expect(settings.blocksExternalGesture).toBeUndefined();
  });

  it('keeps the gesture identity stable across enabled, Reduce Motion and board-width changes', () => {
    const pager = makePager();
    const { result, rerender } = renderHook((props: Options) => useCarouselGesture(props), {
      initialProps: makeOptions({ pager }),
    });

    const firstGesture = result.current.gesture;

    rerender(makeOptions({ pager, enabled: false, boardWidth: 280 }));
    rerender(makeOptions({ pager, reduceMotion: true, onSwipeNext: vi.fn() }));

    expect(result.current.gesture).toBe(firstGesture);
    // One composition total — recomposing mid-session is the iOS RNGH wedge.
    expect(recordedBuilders).toHaveLength(1);
  });

  it('moves the anchor when the fling lands, in the frame the offset goes back to 0', () => {
    const pager = makePager();
    renderHook(() => useCarouselGesture(makeOptions({ pager })));

    swipe(latestHandlers(), -(SWIPE_THRESHOLD + 1));

    expect(pager.uiSteps.value).toBe(1);
    expect(pager.isAnimating.value).toBe(true);
    expect(pager.flingDirection.value).toBe(1);
    expect(pager.translateX.value).toBe(-FLING_TARGET);
    expect(pager.anchorPage.value).toBe(0);

    landFling();

    expect(pager.anchorPage.value).toBe(1);
    expect(pager.translateX.value).toBe(0);
    expect(pager.isAnimating.value).toBe(false);
    expect(pager.flingDirection.value).toBe(0);
  });

  it('tells the JS thread once the incoming board has stopped in the middle, and only once', () => {
    const pager = makePager();
    renderHook(() => useCarouselGesture(makeOptions({ pager })));

    swipe(latestHandlers(), -(SWIPE_THRESHOLD + 1));
    // Finger-up: nothing yet. Changing the climb can cost the UI thread a frame,
    // and both boards are moving.
    expect(pager.requestStep).not.toHaveBeenCalled();

    flingReaches(pager, -(BOARD_WIDTH - 40));
    expect(pager.requestStep).not.toHaveBeenCalled();

    // The outgoing board has travelled its own width: the incoming one is home.
    flingReaches(pager, -BOARD_WIDTH);
    expect(pager.requestStep).toHaveBeenCalledWith(1, 1, expect.any(Function));
    expect(onSwipeNext).toHaveBeenCalledTimes(1);
    // The anchor still waits for the outgoing board to leave.
    expect(pager.anchorPage.value).toBe(0);

    flingReaches(pager, -(BOARD_WIDTH + 60));
    landFling();
    expect(pager.requestStep).toHaveBeenCalledTimes(1);
    expect(onSwipeNext).toHaveBeenCalledTimes(1);
    expect(pager.anchorPage.value).toBe(1);
  });

  it('tells the JS thread at once when the board was let go already past the middle', () => {
    const pager = makePager();
    renderHook(() => useCarouselGesture(makeOptions({ pager })));
    const handlers = latestHandlers();

    handlers.onStart({ translationX: 0 });
    handlers.onUpdate({ translationX: -(BOARD_WIDTH + 10) });
    runStoppedReaction();
    handlers.onEnd({ translationX: -(BOARD_WIDTH + 10), velocityX: 0 });
    flingReaches(pager, -(BOARD_WIDTH + 12));

    expect(pager.requestStep).toHaveBeenCalledWith(1, 1, expect.any(Function));
  });

  it('tells the JS thread when the fling lands if it had not been told', () => {
    const pager = makePager();
    renderHook(() => useCarouselGesture(makeOptions({ pager })));

    swipe(latestHandlers(), -(SWIPE_THRESHOLD + 1));
    landFling();

    expect(pager.requestStep).toHaveBeenCalledWith(1, 1, expect.any(Function));
    expect(onSwipeNext).toHaveBeenCalledTimes(1);
  });

  it('steps back the same way', () => {
    const pager = makePager();
    renderHook(() => useCarouselGesture(makeOptions({ pager })));

    swipe(latestHandlers(), SWIPE_THRESHOLD + 1);
    expect(pager.translateX.value).toBe(FLING_TARGET);
    flingReaches(pager, BOARD_WIDTH);
    expect(pager.requestStep).toHaveBeenCalledWith(-1, 1, expect.any(Function));
    expect(onSwipePrevious).toHaveBeenCalledTimes(1);

    landFling();
    expect(pager.anchorPage.value).toBe(-1);
    expect(pager.translateX.value).toBe(0);
  });

  it('commits a short hard flick', () => {
    const pager = makePager();
    renderHook(() => useCarouselGesture(makeOptions({ pager })));

    swipe(latestHandlers(), -20, -1200);
    landFling();
    expect(onSwipeNext).toHaveBeenCalledTimes(1);
  });

  it('judges a release against the pager as it is NOW, not as it was when the gesture was composed', () => {
    const pager = makePager();
    renderHook(() => useCarouselGesture(makeOptions({ pager })));
    const handlers = latestHandlers();

    // The queue ended there since: no page to the right any more.
    pager.jsState.value = { center: 0, hasPrevious: true, hasNext: false, processedStep: 0 };
    swipe(handlers, -(SWIPE_THRESHOLD + 1));

    expect(onSwipeNext).not.toHaveBeenCalled();
    expect(pager.requestStep).not.toHaveBeenCalled();
    expect(pager.isAnimating.value).toBe(false);
    expect(pager.anchorPage.value).toBe(0);
  });

  it('holds the drag at 0 towards a side with no page', () => {
    const pager = makePager({ hasNext: false });
    renderHook(() => useCarouselGesture(makeOptions({ pager })));
    const handlers = latestHandlers();

    handlers.onStart({ translationX: 0 });
    handlers.onUpdate({ translationX: -50 });
    expect(pager.translateX.value).toBe(0);

    handlers.onUpdate({ translationX: 50 });
    expect(pager.translateX.value).toBe(50);
  });

  it('does not swipe past the pages the JS thread has mounted while it is one step behind', () => {
    const pager = makePager();
    renderHook(() => useCarouselGesture(makeOptions({ pager })));
    const handlers = latestHandlers();

    swipe(handlers, -(SWIPE_THRESHOLD + 1));
    landFling();
    // The UI thread is on page 1; the JS thread still has page 0 in the middle,
    // so page 2 does not exist yet. Back to page 0 is always there.
    handlers.onStart({ translationX: 0 });
    handlers.onUpdate({ translationX: -50 });
    expect(pager.translateX.value).toBe(0);
    handlers.onUpdate({ translationX: 50 });
    expect(pager.translateX.value).toBe(50);

    // It catches up: page 1 is its middle page, with page 2 beside it.
    pager.jsState.value = { center: 1, hasPrevious: true, hasNext: true, processedStep: 1 };
    handlers.onUpdate({ translationX: -50 });
    expect(pager.translateX.value).toBe(-50);
  });

  it('springs back without committing below the threshold', () => {
    const pager = makePager();
    renderHook(() => useCarouselGesture(makeOptions({ pager })));

    swipe(latestHandlers(), -(SWIPE_THRESHOLD - 1));

    expect(onSwipeNext).not.toHaveBeenCalled();
    expect(onSwipePrevious).not.toHaveBeenCalled();
    expect(pager.translateX.value).toBe(0);
    expect(pager.anchorPage.value).toBe(0);
  });

  it('looks the navigation callback up when the step runs, not when the finger lifted', () => {
    const pager = makePager();
    const waiting: (() => void)[] = [];
    pager.requestStep.mockImplementation((_direction: 1 | -1, _step: number, navigate: () => void) => {
      waiting.push(navigate);
    });
    const laterOnSwipeNext = vi.fn();
    const { rerender } = renderHook((props: Options) => useCarouselGesture(props), {
      initialProps: makeOptions({ pager }),
    });

    swipe(latestHandlers(), -(SWIPE_THRESHOLD + 1));
    landFling();
    // The drawer rendered again before the pager got to this step.
    rerender(makeOptions({ pager, onSwipeNext: laterOnSwipeNext }));
    waiting[0]();

    expect(onSwipeNext).not.toHaveBeenCalled();
    expect(laterOnSwipeNext).toHaveBeenCalledTimes(1);
  });

  it('starts a drag over when the pager drops the page under it', () => {
    const pager = makePager();
    renderHook(() => useCarouselGesture(makeOptions({ pager })));
    const handlers = latestHandlers();

    handlers.onStart({ translationX: 0 });
    handlers.onUpdate({ translationX: -60 });
    expect(pager.translateX.value).toBe(-60);

    // A crew member changed the climb: the pager went to the JS thread's page.
    pager.translateX.value = 0;
    pager.resetGeneration.value += 1;
    handlers.onUpdate({ translationX: -70 });
    // From the finger's position now, not the 70 points it had already travelled.
    expect(pager.translateX.value).toBe(0);
    handlers.onUpdate({ translationX: -95 });
    expect(pager.translateX.value).toBe(-25);
  });

  it('fires the haptic once the finger has travelled the commit distance, and only towards a page', async () => {
    const { hapticMedium } = await import('../../../lib/haptics');
    const pager = makePager({ hasNext: false });
    renderHook(() => useCarouselGesture(makeOptions({ pager })));
    const handlers = latestHandlers();

    handlers.onStart({ translationX: 0 });
    handlers.onUpdate({ translationX: -(SWIPE_THRESHOLD + 5) });
    expect(hapticMedium).not.toHaveBeenCalled();

    handlers.onUpdate({ translationX: SWIPE_THRESHOLD + 5 });
    handlers.onUpdate({ translationX: SWIPE_THRESHOLD + 15 });
    expect(hapticMedium).toHaveBeenCalledTimes(1);
  });

  it('writes the board width where the header can read it', () => {
    const pager = makePager();
    const { rerender } = renderHook((props: Options) => useCarouselGesture(props), {
      initialProps: makeOptions({ pager }),
    });
    expect(pager.slideWidth.value).toBe(BOARD_WIDTH);
    rerender(makeOptions({ pager, boardWidth: 280 }));
    expect(pager.slideWidth.value).toBe(280);
  });

  it('with Reduce Motion, moves the anchor at finger-up with no fling', () => {
    const pager = makePager();
    renderHook(() => useCarouselGesture(makeOptions({ pager, reduceMotion: true })));

    swipe(latestHandlers(), -(SWIPE_THRESHOLD + 1));

    expect(onSwipeNext).toHaveBeenCalledTimes(1);
    expect(pager.anchorPage.value).toBe(1);
    expect(pager.translateX.value).toBe(0);
    expect(pager.isAnimating.value).toBe(false);
    expect(springCallbacks).toHaveLength(0);
  });

  describe('a swipe that starts while the last fling is still running', () => {
    function startFling(pager: ReturnType<typeof makePager>, handlers: RecordedHandlers, reachedOffset: number) {
      swipe(handlers, -(SWIPE_THRESHOLD + 1));
      // The mock jumps to the fling's target; put the board where a real fling would be.
      pager.translateX.value = reachedOffset;
    }

    it('takes the fling over: the anchor moves now and both boards stay where they were', () => {
      const pager = makePager();
      renderHook(() => useCarouselGesture(makeOptions({ pager })));
      const handlers = latestHandlers();
      startFling(pager, handlers, -200);
      // The incoming board had not stopped yet, so the JS thread has not heard.
      expect(pager.requestStep).not.toHaveBeenCalled();

      handlers.onStart({ translationX: -12 });

      // It hears now: the swipe that took over needs the page after this one.
      expect(pager.requestStep).toHaveBeenCalledWith(1, 1, expect.any(Function));

      // The incoming board was 120 short of the middle (320 wide, outgoing at
      // -200). In the new anchor's terms it is the middle page, 120 to the right.
      expect(pager.anchorPage.value).toBe(1);
      expect(pager.isAnimating.value).toBe(false);
      expect(pager.flingDirection.value).toBe(0);
      expect(pager.translateX.value).toBe(120);

      // The finger carries on from there. No jump to its own 62 points of travel.
      handlers.onUpdate({ translationX: -62 });
      expect(pager.translateX.value).toBe(70);
    });

    it('starts from 0 when the incoming board had already reached the middle', () => {
      const pager = makePager();
      renderHook(() => useCarouselGesture(makeOptions({ pager })));
      const handlers = latestHandlers();
      startFling(pager, handlers, -(BOARD_WIDTH + 40));

      handlers.onStart({ translationX: -12 });

      expect(pager.anchorPage.value).toBe(1);
      expect(pager.translateX.value).toBe(0);
    });

    it('is not moved a second time by the fling it interrupted', () => {
      const pager = makePager();
      renderHook(() => useCarouselGesture(makeOptions({ pager })));
      const handlers = latestHandlers();
      startFling(pager, handlers, -200);
      const interruptedFling = springCallbacks[springCallbacks.length - 1];

      handlers.onStart({ translationX: -12 });
      // Reanimated reports the cancelled spring as unfinished. Even a stray
      // "finished" must not step again: there is no fling left to land.
      interruptedFling(false);
      interruptedFling(true);

      expect(pager.anchorPage.value).toBe(1);
      expect(pager.translateX.value).toBe(120);
    });

    it('counts a hard flick even though the offset has not crossed 0 yet', () => {
      const pager = makePager();
      renderHook(() => useCarouselGesture(makeOptions({ pager })));
      const handlers = latestHandlers();
      startFling(pager, handlers, -200);
      // The JS thread rendered the first step while that fling ran.
      pager.jsState.value = { center: 1, hasPrevious: true, hasNext: true, processedStep: 1 };

      handlers.onStart({ translationX: -12 });
      handlers.onUpdate({ translationX: -60 });
      // 48 points of travel leaves the offset at +72, still right of the middle.
      expect(pager.translateX.value).toBe(72);
      handlers.onEnd({ translationX: -60, velocityX: -2500 });

      expect(pager.flingDirection.value).toBe(1);
      landFling();
      expect(onSwipeNext).toHaveBeenCalledTimes(2);
      expect(pager.requestStep).toHaveBeenLastCalledWith(1, 2, expect.any(Function));
      expect(pager.anchorPage.value).toBe(2);
    });

    it('settles on the page it reached when the JS thread has not mounted the one after', () => {
      const pager = makePager();
      renderHook(() => useCarouselGesture(makeOptions({ pager })));
      const handlers = latestHandlers();
      startFling(pager, handlers, -200);

      handlers.onStart({ translationX: -12 });
      handlers.onUpdate({ translationX: -60 });
      handlers.onEnd({ translationX: -60, velocityX: -2500 });

      // Page 2 does not exist yet, so this swipe changes nothing more; the first one stands.
      expect(onSwipeNext).toHaveBeenCalledTimes(1);
      expect(pager.anchorPage.value).toBe(1);
      expect(pager.translateX.value).toBe(0);
      expect(pager.isAnimating.value).toBe(false);
    });
  });

  // Direction lock — biased toward horizontal (VERTICAL_LOCK_RATIO) so a
  // horizontal-intended swipe that drifts down still drives the carousel
  // instead of falling through to the drawer's pull-to-dismiss.
  function makeState() {
    return { activate: vi.fn(), fail: vi.fn() };
  }
  function lockFrom(handlers: RecordedHandlers, dx: number, dy: number, state: ReturnType<typeof makeState>) {
    handlers.onTouchesDown({ allTouches: [{ absoluteX: 100, absoluteY: 100 }] });
    handlers.onTouchesMove({ allTouches: [{ absoluteX: 100 + dx, absoluteY: 100 + dy }] }, state);
  }

  it('locks horizontal for a slightly-diagonal swipe that the symmetric rule would call vertical', () => {
    renderHook(() => useCarouselGesture(makeOptions()));
    const state = makeState();
    lockFrom(latestHandlers(), 10, 12, state); // |dy|(12) < |dx|(10) × 1.5

    expect(state.activate).toHaveBeenCalledTimes(1);
    expect(state.fail).not.toHaveBeenCalled();
  });

  it('still locks vertical (and fails) for a clearly-vertical drag', () => {
    renderHook(() => useCarouselGesture(makeOptions()));
    const state = makeState();
    lockFrom(latestHandlers(), 4, 30, state); // |dy|(30) ≥ |dx|(4) × 1.5

    expect(state.fail).toHaveBeenCalledTimes(1);
    expect(state.activate).not.toHaveBeenCalled();
  });

  it('stays committed to horizontal once locked, even if the finger then drifts vertically', () => {
    renderHook(() => useCarouselGesture(makeOptions()));
    const handlers = latestHandlers();
    const state = makeState();
    lockFrom(handlers, 30, 4, state); // lock horizontal
    state.activate.mockClear();

    handlers.onTouchesMove({ allTouches: [{ absoluteX: 130, absoluteY: 220 }] }, state); // big Y drift

    expect(state.activate).toHaveBeenCalledTimes(1);
    expect(state.fail).not.toHaveBeenCalled();
  });

  it('yields to a second finger even after locking horizontal', () => {
    renderHook(() => useCarouselGesture(makeOptions()));
    const handlers = latestHandlers();
    const state = makeState();
    lockFrom(handlers, 30, 4, state);
    state.activate.mockClear();
    handlers.onTouchesMove(
      {
        allTouches: [
          { absoluteX: 130, absoluteY: 104 },
          { absoluteX: 170, absoluteY: 140 },
        ],
      },
      state,
    );
    expect(state.fail).toHaveBeenCalledTimes(1);
    expect(state.activate).not.toHaveBeenCalled();
  });

  it('fails an initial pinch and resets direction after repeated cancellation', () => {
    renderHook(() => useCarouselGesture(makeOptions()));
    const handlers = latestHandlers();
    const state = makeState();
    handlers.onTouchesDown(
      {
        allTouches: [
          { absoluteX: 100, absoluteY: 100 },
          { absoluteX: 120, absoluteY: 120 },
        ],
      },
      state,
    );
    expect(state.fail).toHaveBeenCalledTimes(1);
    handlers.onFinalize();
    for (let attempt = 0; attempt < 3; attempt++) {
      state.fail.mockClear();
      lockFrom(handlers, 30, 4, state);
      handlers.onTouchesCancelled({ allTouches: [] }, state);
      expect(state.fail).toHaveBeenCalledTimes(1);
      handlers.onFinalize();
      state.fail.mockClear();
      state.activate.mockClear();
      lockFrom(handlers, 0, 23, state);
      expect(state.fail).toHaveBeenCalledTimes(1);
      expect(state.activate).not.toHaveBeenCalled();
      handlers.onFinalize();
    }
  });
});
