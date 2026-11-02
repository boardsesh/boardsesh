// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import type { SharedValue } from 'react-native-reanimated';
import { SWIPE_OFFSCREEN_PAD, SWIPE_THRESHOLD } from '@boardsesh/play-view';
import type { BoardArtReadiness } from '../../../lib/board-render/ready-board-art';

const platform = vi.hoisted(() => ({ OS: 'ios' }));
vi.mock('react-native', () => ({ Platform: platform }));

// The hook composes a reanimated worklet gesture — stub the native layers so it
// runs in node. What these tests are really about: the Pan gesture composes
// ONCE per mount (recomposing mid-session left RNGH stuck on iOS); which page is
// in the middle is settled by the worklets, from the pager's shared values,
// without waiting for the JS thread; a swipe that starts while the last fling
// is still running takes it over instead of being ignored; and a fling or a
// drag survives the carousel being taken down under it, because what it needs
// is the pager's.

const springCallbacks = vi.hoisted(() => [] as ((finished: boolean) => void)[]);
// A waiting release's clock: a delayed no-op timing whose callback the test runs.
type Deadline = { delayMs: number; reduceMotion: unknown; finish: (finished: boolean) => void };
const deadlines = vi.hoisted(() => [] as Deadline[]);
const timingCallbacks = vi.hoisted(() => [] as ((finished: boolean) => void)[]);
const cancelAnimation = vi.hoisted(() => vi.fn());
const reactions = vi.hoisted(() => [] as { prepare: () => unknown; react: (snapshot: never) => void }[]);

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
    cancelAnimation,
    // Reactions run only when a test delivers a UI-thread update. In
    // particular React can remain behind across a second complete gesture.
    useAnimatedReaction: (prepare: () => unknown, react: (snapshot: never) => void) => {
      reactions.push({ prepare, react });
    },
    ReduceMotion: { System: 'system', Always: 'always', Never: 'never' },
    withTiming: (toValue: unknown, _config?: unknown, onFinished?: (finished: boolean) => void) => {
      if (onFinished) timingCallbacks.push(onFinished);
      return toValue;
    },
    // Hands the delayed timing's callback to the test, which decides when the time is up.
    withDelay: (delayMs: number, animation: unknown, reduceMotion?: unknown) => {
      const finish = timingCallbacks.pop();
      if (finish) deadlines.push({ delayMs, reduceMotion, finish });
      return animation;
    },
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
    runOnUI:
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

import { RELEASE_ART_DEADLINE_MS, useCarouselGesture } from '../use-carousel-gesture';
import {
  useSwipeNavigation,
  useSwipePager,
  useSwipePages,
  type SwipePager,
  type SwipePagerJsState,
} from '../use-swipe-pager';

type Options = Parameters<typeof useCarouselGesture>[0];

const BOARD_WIDTH = 320;
const SCREEN_WIDTH = 390;
const FLING_TARGET = SCREEN_WIDTH + SWIPE_OFFSCREEN_PAD;

function shared<Value>(value: Value) {
  return { value } as unknown as SharedValue<Value>;
}

/**
 * A pager whose JS side has rendered page 0 with a neighbour each side.
 *
 * `tellUntoldStep` does what the real one does, so a test can see which step
 * reached the JS thread and that it got there once. WHEN the pager tells it of
 * its own accord (the incoming board stopping in the middle) is the pager's
 * business and is tested with it.
 */
function makePager(state: Partial<SwipePagerJsState> = {}, { trackEnd = false }: { trackEnd?: boolean } = {}) {
  const requestStep = vi.fn();
  const untoldStep = shared(0);
  const flingDirection = shared(0);
  return {
    trackEndAvailable: shared(trackEnd),
    reachTrackEnd: vi.fn(),
    setTrackEndHandler: vi.fn(),
    translateX: shared(0),
    isAnimating: shared(false),
    anchorPage: shared(0),
    flingDirection,
    uiSteps: shared(0),
    jsState: shared<SwipePagerJsState>({ center: 0, hasPrevious: true, hasNext: true, processedStep: 0, ...state }),
    slideWidth: shared(0),
    resetGeneration: shared(0),
    untoldStep,
    tellUntoldStep: () => {
      const step = untoldStep.value;
      if (step === 0) return;
      untoldStep.value = 0;
      requestStep(flingDirection.value > 0 ? 1 : -1, step);
    },
    requestStep,
    stepRendered: vi.fn(),
    noteStepArtWait: vi.fn(),
    setNavigation: vi.fn(),
  } as unknown as SwipePager & {
    requestStep: ReturnType<typeof vi.fn>;
    reachTrackEnd: ReturnType<typeof vi.fn>;
    noteStepArtWait: ReturnType<typeof vi.fn>;
  };
}

function makeOptions(overrides: Partial<Options> = {}): Options {
  return {
    pager: makePager(),
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

/** The waiting release's clock runs out (`finished` false: it was cancelled). */
function passDeadline(finished = true) {
  const deadline = deadlines[deadlines.length - 1];
  if (!deadline) throw new Error('no release is waiting');
  deadline.finish(finished);
}

function renderCarouselWithPendingReaction(initialOptions: Options) {
  const reactionStart = reactions.length;
  const carousel = renderHook((options: Options) => useCarouselGesture(options), { initialProps: initialOptions });
  // Capture only this carousel's registrations, excluding any pager reactions.
  // Adding a second reaction here requires choosing its role explicitly.
  const registeredReactions = reactions.slice(reactionStart);
  const [reaction] = registeredReactions;
  if (registeredReactions.length !== 1 || !reaction) {
    throw new Error(`Expected one useCarouselGesture reaction, received ${registeredReactions.length}`);
  }
  return { ...carousel, catchUp: () => reaction.react(reaction.prepare() as never) };
}

describe('useCarouselGesture', () => {
  beforeEach(() => {
    reactions.length = 0;
    vi.clearAllMocks();
    recordedBuilders.length = 0;
    springCallbacks.length = 0;
    deadlines.length = 0;
    timingCallbacks.length = 0;
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

  it('keeps the gesture identity stable across enabled, board-width and screen-width changes', () => {
    const pager = makePager();
    const { result, rerender } = renderHook((props: Options) => useCarouselGesture(props), {
      initialProps: makeOptions({ pager }),
    });

    const firstGesture = result.current.gesture;

    rerender(makeOptions({ pager, enabled: false, boardWidth: 280 }));
    rerender(makeOptions({ pager, screenWidth: 430 }));

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

  it('leaves the JS thread out of it at finger-up: the pager tells it while the fling runs', () => {
    const pager = makePager();
    renderHook(() => useCarouselGesture(makeOptions({ pager })));

    swipe(latestHandlers(), -(SWIPE_THRESHOLD + 1));

    // Changing the climb can cost the UI thread a frame, and both boards are moving.
    expect(pager.requestStep).not.toHaveBeenCalled();
    // The step is the pager's to hand over, so it outlives this carousel.
    expect(pager.untoldStep.value).toBe(1);
  });

  it('tells the JS thread when the fling lands if it had not been told', () => {
    const pager = makePager();
    renderHook(() => useCarouselGesture(makeOptions({ pager })));

    swipe(latestHandlers(), -(SWIPE_THRESHOLD + 1));
    landFling();

    expect(pager.requestStep).toHaveBeenCalledExactlyOnceWith(1, 1);
    expect(pager.untoldStep.value).toBe(0);
  });

  it('does not tell it twice when the pager had told it during the fling', () => {
    const pager = makePager();
    renderHook(() => useCarouselGesture(makeOptions({ pager })));

    swipe(latestHandlers(), -(SWIPE_THRESHOLD + 1));
    // The incoming board stopped in the middle: the pager's own reaction.
    pager.tellUntoldStep();
    landFling();

    expect(pager.requestStep).toHaveBeenCalledExactlyOnceWith(1, 1);
    expect(pager.anchorPage.value).toBe(1);
  });

  it('steps back the same way', () => {
    const pager = makePager();
    renderHook(() => useCarouselGesture(makeOptions({ pager })));

    swipe(latestHandlers(), SWIPE_THRESHOLD + 1);
    expect(pager.translateX.value).toBe(FLING_TARGET);

    landFling();
    expect(pager.requestStep).toHaveBeenCalledExactlyOnceWith(-1, 1);
    expect(pager.anchorPage.value).toBe(-1);
    expect(pager.translateX.value).toBe(0);
  });

  it('commits a short hard flick', () => {
    const pager = makePager();
    renderHook(() => useCarouselGesture(makeOptions({ pager })));

    swipe(latestHandlers(), -20, -1200);
    landFling();
    expect(pager.requestStep).toHaveBeenCalledExactlyOnceWith(1, 1);
  });

  it('judges a release against the pager as it is NOW, not as it was when the gesture was composed', () => {
    const pager = makePager();
    renderHook(() => useCarouselGesture(makeOptions({ pager })));
    const handlers = latestHandlers();

    // The queue ended there since: no page to the right any more.
    pager.jsState.value = { center: 0, hasPrevious: true, hasNext: false, processedStep: 0 };
    swipe(handlers, -(SWIPE_THRESHOLD + 1));

    expect(pager.requestStep).not.toHaveBeenCalled();
    expect(pager.untoldStep.value).toBe(0);
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

  // Issue #6664: past the list's last climb a forward swipe shows the end card.
  it('gives a little past the end of a list, and shows the end card on a full swipe', () => {
    const pager = makePager({ hasNext: false }, { trackEnd: true });
    renderHook(() => useCarouselGesture(makeOptions({ pager })));
    const handlers = latestHandlers();

    handlers.onStart({ translationX: 0 });
    handlers.onUpdate({ translationX: -100 });
    // Follows the finger a little, so the end reads as an end rather than a dead board.
    expect(pager.translateX.value).toBeLessThan(0);
    expect(pager.translateX.value).toBeGreaterThan(-100);
    handlers.onEnd({ translationX: -(SWIPE_THRESHOLD + 1), velocityX: 0 });

    expect(pager.reachTrackEnd).toHaveBeenCalledTimes(1);
    // No step: the climb on screen stays, and the board springs back.
    expect(pager.untoldStep.value).toBe(0);
    expect(pager.anchorPage.value).toBe(0);
    expect(pager.translateX.value).toBe(0);
  });

  it('does not show the end card for a short drag, a swipe back, or without one to show', () => {
    const atEnd = makePager({ hasNext: false }, { trackEnd: true });
    renderHook(() => useCarouselGesture(makeOptions({ pager: atEnd })));
    swipe(latestHandlers(), -(SWIPE_THRESHOLD - 1));
    swipe(latestHandlers(), SWIPE_THRESHOLD + 1);
    expect(atEnd.reachTrackEnd).not.toHaveBeenCalled();

    const noCard = makePager({ hasNext: false });
    renderHook(() => useCarouselGesture(makeOptions({ pager: noCard })));
    const handlers = latestHandlers();
    handlers.onStart({ translationX: 0 });
    handlers.onUpdate({ translationX: -100 });
    expect(noCard.translateX.value).toBe(0);
    handlers.onEnd({ translationX: -(SWIPE_THRESHOLD + 1), velocityX: 0 });
    expect(noCard.reachTrackEnd).not.toHaveBeenCalled();
  });

  it('steps to the next climb, not the end card, when there is a next climb', () => {
    const pager = makePager({}, { trackEnd: true });
    renderHook(() => useCarouselGesture(makeOptions({ pager })));
    swipe(latestHandlers(), -(SWIPE_THRESHOLD + 1));
    expect(pager.reachTrackEnd).not.toHaveBeenCalled();
    expect(pager.untoldStep.value).toBe(1);
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

  describe('a release waiting for React to mount its neighbour', () => {
    function releaseWhileBehind(direction: 1 | -1 = 1, options: Partial<Options> = {}) {
      const pager = makePager();
      const carousel = renderCarouselWithPendingReaction(makeOptions({ ...options, pager }));
      const handlers = latestHandlers();
      const { catchUp } = carousel;
      swipe(handlers, -direction * (SWIPE_THRESHOLD + 1));
      landFling();
      // A second short, hard flick qualifies before its page exists.
      swipe(handlers, -direction * 20, -direction * 1200);
      handlers.onFinalize();
      return { pager, handlers, carousel, catchUp };
    }

    it.each([1, -1] as const)(
      'retains a fast release toward %s and commits exactly once after catch-up',
      (direction) => {
        const { pager, catchUp } = releaseWhileBehind(direction);
        expect(pager.uiSteps.value).toBe(1);
        expect(pager.translateX.value).toBe(0);
        catchUp();
        expect(pager.isAnimating.value).toBe(false);

        pager.jsState.value = { center: direction, hasPrevious: true, hasNext: true, processedStep: 1 };
        catchUp();

        expect(pager.uiSteps.value).toBe(2);
        expect(pager.flingDirection.value).toBe(direction);
        expect(pager.translateX.value).toBe(-direction * FLING_TARGET);
        catchUp();
        expect(pager.uiSteps.value).toBe(2);
        landFling();
        expect(pager.anchorPage.value).toBe(2 * direction);
        expect(pager.requestStep).toHaveBeenLastCalledWith(direction, 2);
        expect(pager.requestStep).toHaveBeenCalledTimes(2);
      },
    );

    it('waits for an actual React commit before starting the second fling', async () => {
      const climbs = ['a', 'b', 'c', 'd', 'e'];
      const drawer = renderHook(() => {
        const [currentIndex, setCurrentIndex] = useState(1);
        const { pager, stepSignal } = useSwipePager();
        useSwipePages(pager, stepSignal, climbs[currentIndex - 1], climbs[currentIndex], climbs[currentIndex + 1]);
        useSwipeNavigation(
          pager,
          () => setCurrentIndex(currentIndex + 1),
          () => setCurrentIndex(currentIndex - 1),
        );
        return { pager, currentIndex };
      });
      const { pager } = drawer.result.current;
      const { catchUp } = renderCarouselWithPendingReaction(makeOptions({ pager }));
      const handlers = latestHandlers();
      let beforeReactCommit: { uiSteps: number; processedStep: number } | undefined;

      await act(async () => {
        swipe(handlers, -(SWIPE_THRESHOLD + 1));
        landFling();
        swipe(handlers, -(SWIPE_THRESHOLD + 1));
        catchUp();
        // Preserve the state before act flushes React, then assert outside it.
        beforeReactCommit = { uiSteps: pager.uiSteps.value, processedStep: pager.jsState.value.processedStep };
      });

      expect(beforeReactCommit).toEqual({ uiSteps: 1, processedStep: 0 });
      expect(drawer.result.current.currentIndex).toBe(2);
      expect(pager.jsState.value.processedStep).toBe(1);
      act(() => catchUp());
      expect(pager.uiSteps.value).toBe(2);
      await act(async () => landFling());
      expect(drawer.result.current.currentIndex).toBe(3);
      expect(pager.jsState.value.processedStep).toBe(2);
    });

    it.each([1, -1] as const)('discards the release at the confirmed queue boundary toward %s', (direction) => {
      const { pager, catchUp } = releaseWhileBehind(direction);
      pager.jsState.value = {
        center: direction,
        hasPrevious: direction > 0,
        hasNext: direction < 0,
        processedStep: 1,
      };
      catchUp();
      pager.jsState.value = { center: direction, hasPrevious: true, hasNext: true, processedStep: 1 };
      catchUp();
      expect(pager.uiSteps.value).toBe(1);
      expect(pager.isAnimating.value).toBe(false);
    });

    it('opens the end card once when a retained forward release reaches the confirmed last climb', () => {
      const { pager, catchUp } = releaseWhileBehind();
      pager.trackEndAvailable.value = true;
      // The end-card layout effect can run before the pager's passive effect
      // acknowledges the preceding step. Neither can show it prematurely.
      catchUp();
      expect(pager.reachTrackEnd).not.toHaveBeenCalled();

      pager.jsState.value = { center: 1, hasPrevious: true, hasNext: false, processedStep: 1 };
      catchUp();
      catchUp();

      expect(pager.reachTrackEnd).toHaveBeenCalledExactlyOnceWith();
      expect(pager.uiSteps.value).toBe(1);
      expect(pager.anchorPage.value).toBe(1);
      expect(pager.translateX.value).toBe(0);
      expect(pager.isAnimating.value).toBe(false);
    });

    it('discards the release when the queue refused or replaced the preceding step', () => {
      const { pager, catchUp } = releaseWhileBehind();
      pager.jsState.value = { center: 0, hasPrevious: true, hasNext: true, processedStep: 1 };
      catchUp();
      pager.jsState.value = { center: 1, hasPrevious: true, hasNext: true, processedStep: 1 };
      catchUp();
      expect(pager.uiSteps.value).toBe(1);
    });

    it.each(['reset', 'anchor', 'step'] as const)(
      'discards the release when its %s changes while React is behind',
      (change) => {
        const { pager, catchUp } = releaseWhileBehind();
        if (change === 'reset') pager.resetGeneration.value += 1;
        if (change === 'anchor') pager.anchorPage.value = 0;
        if (change === 'step') pager.uiSteps.value = 2;
        catchUp();
        pager.resetGeneration.value = 0;
        pager.anchorPage.value = 1;
        pager.uiSteps.value = 1;
        pager.jsState.value = { center: 1, hasPrevious: true, hasNext: true, processedStep: 1 };
        catchUp();
        expect(pager.uiSteps.value).toBe(1);
      },
    );

    it.each(['touch', 'start', 'cancel'] as const)('discards the release on a new %s interaction', (interaction) => {
      const { pager, handlers, catchUp } = releaseWhileBehind();
      if (interaction === 'touch') handlers.onTouchesDown({ allTouches: [{ absoluteX: 100, absoluteY: 100 }] });
      if (interaction === 'start') handlers.onStart({ translationX: 0 });
      if (interaction === 'cancel') handlers.onTouchesCancelled({ allTouches: [] }, { fail: vi.fn() });
      pager.jsState.value = { center: 1, hasPrevious: true, hasNext: true, processedStep: 1 };
      catchUp();
      expect(pager.uiSteps.value).toBe(1);
    });

    it('lets a new reverse swipe replace the waiting forward release', () => {
      const { pager, handlers, catchUp } = releaseWhileBehind();
      swipe(handlers, SWIPE_THRESHOLD + 1);
      landFling();
      pager.jsState.value = { center: 0, hasPrevious: true, hasNext: true, processedStep: 2 };
      catchUp();
      expect(pager.anchorPage.value).toBe(0);
      expect(pager.uiSteps.value).toBe(2);
      expect(pager.requestStep).toHaveBeenLastCalledWith(-1, 2);
    });

    it('does not recreate a waiting release when cancellation is followed by onEnd', () => {
      const { pager, handlers, catchUp } = releaseWhileBehind();
      handlers.onStart({ translationX: 0 });
      handlers.onUpdate({ translationX: -(SWIPE_THRESHOLD + 1) });
      handlers.onTouchesCancelled({ allTouches: [] }, { fail: vi.fn() });
      handlers.onEnd({ translationX: -(SWIPE_THRESHOLD + 1), velocityX: -1200 }, false);
      handlers.onFinalize({}, false);
      pager.jsState.value = { center: 1, hasPrevious: true, hasNext: true, processedStep: 1 };
      catchUp();
      expect(pager.uiSteps.value).toBe(1);
    });

    it('discards the release while swiping is disabled, even if re-enabled before catch-up', () => {
      const { pager, carousel, catchUp } = releaseWhileBehind();
      carousel.rerender(makeOptions({ pager, enabled: false }));
      catchUp();
      carousel.rerender(makeOptions({ pager, enabled: true }));
      pager.jsState.value = { center: 1, hasPrevious: true, hasNext: true, processedStep: 1 };
      catchUp();
      expect(pager.uiSteps.value).toBe(1);
    });

    it('discards the release when the board is zoomed', () => {
      const isZoomedSV = shared(false);
      const { pager, catchUp } = releaseWhileBehind(1, { isZoomedSV });
      isZoomedSV.value = true;
      catchUp();
      isZoomedSV.value = false;
      pager.jsState.value = { center: 1, hasPrevious: true, hasNext: true, processedStep: 1 };
      catchUp();
      expect(pager.uiSteps.value).toBe(1);
    });

    it('discards the release when the carousel unmounts', () => {
      const { pager, carousel, catchUp } = releaseWhileBehind();
      carousel.unmount();
      pager.jsState.value = { center: 1, hasPrevious: true, hasNext: true, processedStep: 1 };
      catchUp();
      expect(pager.uiSteps.value).toBe(1);
    });

    it('does not retain a drag released below the threshold', () => {
      const { pager, handlers, catchUp } = releaseWhileBehind();
      swipe(handlers, -(SWIPE_THRESHOLD - 1));
      pager.jsState.value = { center: 1, hasPrevious: true, hasNext: true, processedStep: 1 };
      catchUp();
      expect(pager.uiSteps.value).toBe(1);
    });
  });

  describe('a mounted neighbour still waiting for its holds', () => {
    type PageArt = Readonly<Record<number, BoardArtReadiness>>;
    // Date.now() is the release's own clock, for how long it waited.
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(10_000);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    /** A carousel at rest on page 0 with page art as given, and a release toward `direction` waiting on it. */
    function releaseOnto(art: PageArt, direction: 1 | -1 = 1) {
      const pager = makePager();
      const pageArt = shared<PageArt>(art);
      const carousel = renderCarouselWithPendingReaction(makeOptions({ pager, pageArt }));
      swipe(latestHandlers(), -direction * (SWIPE_THRESHOLD + 1));
      return { pager, pageArt, ...carousel };
    }

    it('gives toward a next climb still painting, as a next climb and never as the end card', async () => {
      const { hapticMedium } = await import('../../../lib/haptics');
      const pager = makePager({}, { trackEnd: true });
      const pageArt = shared<PageArt>({ 0: 'ready', 1: 'loading' });
      const { catchUp } = renderCarouselWithPendingReaction(makeOptions({ pager, pageArt }));
      const handlers = latestHandlers();

      handlers.onStart({ translationX: 0 });
      handlers.onUpdate({ translationX: -(SWIPE_THRESHOLD + 1) });

      // The board follows the finger a little, so the swipe reads as heard.
      expect(pager.translateX.value).toBeCloseTo(-(SWIPE_THRESHOLD + 1) * 0.3);
      // Its release will go, so it is felt like any other.
      expect(hapticMedium).toHaveBeenCalledTimes(1);
      handlers.onEnd({ translationX: -(SWIPE_THRESHOLD + 1), velocityX: -1200 });
      expect(pager.reachTrackEnd).not.toHaveBeenCalled();
      expect(pager.uiSteps.value).toBe(0);
      passDeadline();
      catchUp();
      expect(pager.uiSteps.value).toBe(1);
      expect(pager.reachTrackEnd).not.toHaveBeenCalled();
    });

    it.each([1, -1] as const)('follows the finger toward %s with resistance while that board paints', (direction) => {
      const pager = makePager();
      const pageArt = shared<PageArt>({ 0: 'ready', [direction]: 'loading', [-direction]: 'ready' });
      renderCarouselWithPendingReaction(makeOptions({ pager, pageArt }));
      const handlers = latestHandlers();
      handlers.onStart({ translationX: 0 });
      handlers.onUpdate({ translationX: -direction * 100 });
      expect(pager.translateX.value).toBeCloseTo(-direction * 30);
      // The painted side still follows the finger all the way.
      handlers.onUpdate({ translationX: direction * 100 });
      expect(pager.translateX.value).toBe(direction * 100);
      // Painted mid-drag: the board catches up with the finger.
      pageArt.value = { ...pageArt.value, [direction]: 'ready' };
      handlers.onUpdate({ translationX: -direction * 100 });
      expect(pager.translateX.value).toBe(-direction * 100);
    });

    it('gives with resistance, never back against the finger, when a displayed neighbour starts a new artwork attempt', () => {
      const pager = makePager();
      const pageArt = shared<PageArt>({ 0: 'ready', 1: 'ready' });
      renderCarouselWithPendingReaction(makeOptions({ pager, pageArt }));
      const handlers = latestHandlers();
      handlers.onStart({ translationX: 0 });
      handlers.onUpdate({ translationX: -30 });
      expect(pager.translateX.value).toBe(-30);
      pageArt.value = { 0: 'ready', 1: 'loading' };
      // On from where it is, at the resisted rate: 10 more points move it 3.
      handlers.onUpdate({ translationX: -40 });
      expect(pager.translateX.value).toBeCloseTo(-33);
      // The finger turns back: the board closes on the resisted offset (-9) at
      // most twice as fast, then rides it.
      handlers.onUpdate({ translationX: -30 });
      expect(pager.translateX.value).toBeCloseTo(-13);
      handlers.onUpdate({ translationX: -20 });
      expect(pager.translateX.value).toBeCloseTo(-6);
      handlers.onUpdate({ translationX: -10 });
      expect(pager.translateX.value).toBeCloseTo(-3);
    });

    it('never leaves the board over a side that has lost its page', () => {
      // A spring back from a drag toward the next climb is still running when
      // the queue loses that climb, and the climber grabs the board again.
      const pager = makePager({ hasNext: false });
      renderCarouselWithPendingReaction(makeOptions({ pager }));
      const handlers = latestHandlers();
      pager.translateX.value = -60;
      handlers.onStart({ translationX: 0 });
      handlers.onUpdate({ translationX: 10 });
      expect(pager.translateX.value).toBe(10);
    });

    it('catches up with the finger, without a jump, when the board it goes toward paints mid-drag', () => {
      const pager = makePager();
      const pageArt = shared<PageArt>({ 0: 'ready', 1: 'loading' });
      renderCarouselWithPendingReaction(makeOptions({ pager, pageArt }));
      const handlers = latestHandlers();
      handlers.onStart({ translationX: 0 });
      handlers.onUpdate({ translationX: -100 });
      expect(pager.translateX.value).toBeCloseTo(-30);

      pageArt.value = { 0: 'ready', 1: 'ready' };
      // 10 more points of finger close 20 of the 80-point gap, not all of it at once.
      handlers.onUpdate({ translationX: -110 });
      expect(pager.translateX.value).toBeCloseTo(-50);
      handlers.onUpdate({ translationX: -150 });
      expect(pager.translateX.value).toBeCloseTo(-130);
      handlers.onUpdate({ translationX: -170 });
      expect(pager.translateX.value).toBe(-170);
      // Caught up: from here it is under the finger again.
      handlers.onUpdate({ translationX: -180 });
      expect(pager.translateX.value).toBe(-180);
    });

    it('moves with a finger that turns back after the board painted, and never across the middle early', () => {
      const pager = makePager();
      const pageArt = shared<PageArt>({ [-1]: 'ready', 0: 'ready', 1: 'loading' });
      renderCarouselWithPendingReaction(makeOptions({ pager, pageArt }));
      const handlers = latestHandlers();
      handlers.onStart({ translationX: 0 });
      handlers.onUpdate({ translationX: -100 });
      pageArt.value = { ...pageArt.value, 1: 'ready' };

      // With the finger, not toward where the finger now puts it (-90).
      handlers.onUpdate({ translationX: -90 });
      expect(pager.translateX.value).toBeCloseTo(-20);
      // The finger is still left of where it started: the board waits in the
      // middle rather than show the previous climb.
      handlers.onUpdate({ translationX: -50 });
      expect(pager.translateX.value).toBe(0);
      handlers.onUpdate({ translationX: -10 });
      expect(pager.translateX.value).toBe(0);
      handlers.onUpdate({ translationX: 10 });
      expect(pager.translateX.value).toBe(10);
    });

    it.each([1, -1] as const)('retains a release toward %s without exposing a bare board', (direction) => {
      const { pager, pageArt, catchUp } = releaseOnto({ 0: 'ready', [direction]: 'loading' }, direction);
      expect(pager.translateX.value).toBe(0);
      expect(pager.uiSteps.value).toBe(0);
      catchUp();
      expect(pager.isAnimating.value).toBe(false);
      pageArt.value = { ...pageArt.value, [direction]: 'ready' };
      catchUp();
      catchUp();
      expect(pager.uiSteps.value).toBe(1);
      expect(pager.flingDirection.value).toBe(direction);
      landFling();
      expect(pager.requestStep).toHaveBeenCalledExactlyOnceWith(direction, 1);
    });

    it('steps exactly as before onto a board that paints in time, and notes nothing', () => {
      const { pager, pageArt, catchUp } = releaseOnto({ 0: 'ready', 1: 'loading' });
      vi.setSystemTime(10_000 + RELEASE_ART_DEADLINE_MS - 1);
      pageArt.value = { ...pageArt.value, 1: 'ready' };
      catchUp();
      expect(pager.uiSteps.value).toBe(1);
      // The clock that was running for it runs out with nothing left to hurry.
      passDeadline();
      catchUp();
      landFling();
      expect(pager.uiSteps.value).toBe(1);
      expect(pager.requestStep).toHaveBeenCalledExactlyOnceWith(1, 1);
      expect(pager.noteStepArtWait).not.toHaveBeenCalled();
    });

    it('starts no clock and notes nothing for a release onto a board that has painted', () => {
      const { pager } = releaseOnto({ 0: 'ready', 1: 'ready' });
      expect(pager.uiSteps.value).toBe(1);
      expect(pager.translateX.value).toBe(-FLING_TARGET);
      expect(deadlines).toHaveLength(0);
      landFling();
      expect(pager.requestStep).toHaveBeenCalledExactlyOnceWith(1, 1);
      expect(pager.noteStepArtWait).not.toHaveBeenCalled();
    });

    it.each([1, -1] as const)('goes toward %s anyway when the board is still painting at the deadline', (direction) => {
      const { pager, catchUp } = releaseOnto({ 0: 'ready', [direction]: 'loading' }, direction);
      catchUp();
      expect(pager.uiSteps.value).toBe(0);

      vi.setSystemTime(10_000 + RELEASE_ART_DEADLINE_MS);
      passDeadline();
      catchUp();

      expect(pager.uiSteps.value).toBe(1);
      expect(pager.flingDirection.value).toBe(direction);
      expect(pager.translateX.value).toBe(-direction * FLING_TARGET);
      expect(pager.noteStepArtWait).toHaveBeenCalledExactlyOnceWith(1, {
        artState: 'loading',
        waitedMs: RELEASE_ART_DEADLINE_MS,
      });
      // Once: a second delivery of the same state starts no second fling.
      catchUp();
      expect(pager.uiSteps.value).toBe(1);
      landFling();
      expect(pager.anchorPage.value).toBe(direction);
      expect(pager.requestStep).toHaveBeenCalledExactlyOnceWith(direction, 1);
    });

    it('times the wait with a clock Reduce Motion cannot skip', () => {
      // Ten times the slowest normal render (66 ms on an iPhone 13 Pro), and
      // far short of the 4 s the paint watchdog waits before it reports.
      expect(RELEASE_ART_DEADLINE_MS).toBe(700);
      releaseOnto({ 0: 'ready', 1: 'loading' });
      expect(deadlines).toEqual([
        { delayMs: RELEASE_ART_DEADLINE_MS, reduceMotion: 'never', finish: expect.any(Function) },
      ]);
    });

    it('is not hurried by a clock that was cancelled', () => {
      const { pager, catchUp } = releaseOnto({ 0: 'ready', 1: 'loading' });
      passDeadline(false);
      catchUp();
      expect(pager.uiSteps.value).toBe(0);
    });

    it.each(['touch', 'start', 'cancel'] as const)(
      'drops the waiting release on a new %s, and the deadline does not revive it',
      (interaction) => {
        const { pager, catchUp } = releaseOnto({ 0: 'ready', 1: 'loading' });
        const handlers = latestHandlers();
        if (interaction === 'touch') handlers.onTouchesDown({ allTouches: [{ absoluteX: 100, absoluteY: 100 }] });
        if (interaction === 'start') handlers.onStart({ translationX: 0 });
        if (interaction === 'cancel') handlers.onTouchesCancelled({ allTouches: [] }, { fail: vi.fn() });
        passDeadline();
        catchUp();
        expect(pager.uiSteps.value).toBe(0);
        expect(pager.isAnimating.value).toBe(false);
        expect(pager.noteStepArtWait).not.toHaveBeenCalled();
      },
    );

    /** How many times the release's clock was stopped: every cancel but the board's own offset. */
    function clockStops(pager: SwipePager) {
      return cancelAnimation.mock.calls.filter(([value]) => value !== pager.translateX).length;
    }

    it.each(['paints', 'fails', 'touch', 'boundary', 'unmount'] as const)(
      'stops the clock the moment the waiting release %s',
      (outcome) => {
        const { pager, pageArt, catchUp, unmount } = releaseOnto({ 0: 'ready', 1: 'loading' });
        expect(clockStops(pager)).toBe(0);
        if (outcome === 'paints') pageArt.value = { ...pageArt.value, 1: 'ready' };
        if (outcome === 'fails') pageArt.value = { ...pageArt.value, 1: 'failed' };
        if (outcome === 'touch') {
          latestHandlers().onTouchesDown({ allTouches: [{ absoluteX: 100, absoluteY: 100 }] });
        }
        if (outcome === 'boundary') pager.jsState.value = { ...pager.jsState.value, hasNext: false };
        if (outcome === 'unmount') unmount();
        else catchUp();
        expect(clockStops(pager)).toBe(1);
        // Nothing left to stop: a second delivery stops nothing more.
        if (outcome !== 'unmount') catchUp();
        expect(clockStops(pager)).toBe(1);
      },
    );

    describe('swiped again toward the same climb while it waits', () => {
      const touch = { allTouches: [{ absoluteX: 100, absoluteY: 100 }] };

      it('keeps the first release clock: swiping again never makes the wait longer', () => {
        const { pager, catchUp } = releaseOnto({ 0: 'ready', 1: 'loading' });
        const handlers = latestHandlers();
        vi.setSystemTime(10_400);
        handlers.onTouchesDown(touch);
        swipe(handlers, -(SWIPE_THRESHOLD + 1));
        expect(pager.uiSteps.value).toBe(0);
        // What was left of the first one's 700 ms, not a fresh 700.
        expect(deadlines.map(({ delayMs }) => delayMs)).toEqual([RELEASE_ART_DEADLINE_MS, 300]);

        vi.setSystemTime(10_000 + RELEASE_ART_DEADLINE_MS);
        passDeadline();
        catchUp();
        expect(pager.uiSteps.value).toBe(1);
        expect(pager.noteStepArtWait).toHaveBeenCalledExactlyOnceWith(1, {
          artState: 'loading',
          waitedMs: RELEASE_ART_DEADLINE_MS,
        });
      });

      it('goes at once when the first release deadline has already passed', () => {
        const { pager, catchUp } = releaseOnto({ 0: 'ready', 1: 'loading' });
        const handlers = latestHandlers();
        vi.setSystemTime(10_800);
        handlers.onTouchesDown(touch);
        swipe(handlers, -(SWIPE_THRESHOLD + 1));
        // No second clock: its time is up already.
        expect(deadlines).toHaveLength(1);
        catchUp();
        expect(pager.uiSteps.value).toBe(1);
        expect(pager.noteStepArtWait).toHaveBeenCalledExactlyOnceWith(1, { artState: 'loading', waitedMs: 800 });
      });

      it('starts a fresh clock for a swipe the other way', () => {
        const { pager, catchUp } = releaseOnto({ 0: 'ready', 1: 'loading', [-1]: 'loading' });
        const handlers = latestHandlers();
        vi.setSystemTime(10_400);
        handlers.onTouchesDown(touch);
        swipe(handlers, SWIPE_THRESHOLD + 1);
        expect(deadlines.map(({ delayMs }) => delayMs)).toEqual([RELEASE_ART_DEADLINE_MS, RELEASE_ART_DEADLINE_MS]);
        // A stray finish from the first release's clock does not hurry this one.
        deadlines[0].finish(true);
        catchUp();
        expect(pager.uiSteps.value).toBe(0);
        vi.setSystemTime(10_400 + RELEASE_ART_DEADLINE_MS);
        passDeadline();
        catchUp();
        expect(pager.flingDirection.value).toBe(-1);
        expect(pager.noteStepArtWait).toHaveBeenCalledExactlyOnceWith(1, {
          artState: 'loading',
          waitedMs: RELEASE_ART_DEADLINE_MS,
        });
      });

      it('carries only into the very next release', () => {
        const { pager, catchUp } = releaseOnto({ 0: 'ready', 1: 'loading' });
        const handlers = latestHandlers();
        vi.setSystemTime(10_400);
        handlers.onTouchesDown(touch);
        // A short drag let go: no release, and the first one's clock is gone with it.
        swipe(handlers, -(SWIPE_THRESHOLD - 1));
        handlers.onTouchesDown(touch);
        swipe(handlers, -(SWIPE_THRESHOLD + 1));
        expect(deadlines.map(({ delayMs }) => delayMs)).toEqual([RELEASE_ART_DEADLINE_MS, RELEASE_ART_DEADLINE_MS]);
        catchUp();
        expect(pager.uiSteps.value).toBe(0);
      });
    });

    it('steps at once onto a board that failed, and counts it', () => {
      const { pager, catchUp } = releaseOnto({ 0: 'ready', 1: 'failed' });
      expect(pager.uiSteps.value).toBe(1);
      expect(pager.translateX.value).toBe(-FLING_TARGET);
      expect(deadlines).toHaveLength(0);
      expect(pager.noteStepArtWait).toHaveBeenCalledExactlyOnceWith(1, { artState: 'failed', waitedMs: 0 });
      catchUp();
      landFling();
      expect(pager.requestStep).toHaveBeenCalledExactlyOnceWith(1, 1);
    });

    it('lets the board follow the finger all the way toward a board that failed', () => {
      const pager = makePager();
      const pageArt = shared<PageArt>({ 0: 'ready', 1: 'failed' });
      renderCarouselWithPendingReaction(makeOptions({ pager, pageArt }));
      const handlers = latestHandlers();
      handlers.onStart({ translationX: 0 });
      handlers.onUpdate({ translationX: -80 });
      expect(pager.translateX.value).toBe(-80);
    });

    it('steps once a waiting board fails, without waiting for the deadline', () => {
      const { pager, pageArt, catchUp } = releaseOnto({ 0: 'ready', 1: 'loading' });
      vi.setSystemTime(10_250);
      pageArt.value = { ...pageArt.value, 1: 'failed' };
      catchUp();
      expect(pager.uiSteps.value).toBe(1);
      expect(pager.noteStepArtWait).toHaveBeenCalledExactlyOnceWith(1, { artState: 'failed', waitedMs: 250 });
      landFling();
      expect(pager.requestStep).toHaveBeenCalledExactlyOnceWith(1, 1);
    });

    it.each(['React', 'artwork'] as const)('waits for both threads when %s catches up first', (first) => {
      const pager = makePager();
      const pageArt = shared<PageArt>({ 0: 'ready', 1: 'ready', 2: 'loading' });
      const { catchUp } = renderCarouselWithPendingReaction(makeOptions({ pager, pageArt }));
      const handlers = latestHandlers();
      swipe(handlers, -(SWIPE_THRESHOLD + 1));
      landFling();
      swipe(handlers, -(SWIPE_THRESHOLD + 1));
      const reactCatchesUp = () => {
        pager.jsState.value = { center: 1, hasPrevious: true, hasNext: true, processedStep: 1 };
      };
      const artCatchesUp = () => {
        pageArt.value = { ...pageArt.value, 2: 'ready' };
      };
      if (first === 'React') reactCatchesUp();
      else artCatchesUp();
      catchUp();
      expect(pager.uiSteps.value).toBe(1);
      expect(pager.translateX.value).toBe(0);
      if (first === 'React') artCatchesUp();
      else reactCatchesUp();
      catchUp();
      expect(pager.uiSteps.value).toBe(2);
      expect(pager.isAnimating.value).toBe(true);
      landFling();
      expect(pager.requestStep).toHaveBeenLastCalledWith(1, 2);
      expect(pager.noteStepArtWait).not.toHaveBeenCalled();
    });

    /** Page 1 reached, page 2 not mounted yet by React, and a second release toward it waiting. */
    function releaseWhileReactIsBehind(art: PageArt) {
      const pager = makePager();
      const pageArt = shared<PageArt>(art);
      const { catchUp } = renderCarouselWithPendingReaction(makeOptions({ pager, pageArt }));
      const handlers = latestHandlers();
      swipe(handlers, -(SWIPE_THRESHOLD + 1));
      landFling();
      swipe(handlers, -(SWIPE_THRESHOLD + 1));
      expect(pager.jsState.value.processedStep).toBe(0);
      expect(pager.uiSteps.value).toBe(1);
      return { pager, pageArt, catchUp };
    }

    it('never steps onto a page React has not mounted, and gives it the whole deadline once it has', () => {
      const { pager, catchUp } = releaseWhileReactIsBehind({ 0: 'ready', 1: 'ready' });
      // No page, nothing to paint: no clock runs while React is behind.
      expect(deadlines).toHaveLength(0);
      vi.setSystemTime(10_000 + 2 * RELEASE_ART_DEADLINE_MS);
      catchUp();
      expect(pager.uiSteps.value).toBe(1);
      expect(pager.isAnimating.value).toBe(false);

      // React mounts page 2, whose board has not reported yet: it gets its 700
      // ms from now, however long the release had already waited.
      pager.jsState.value = { center: 1, hasPrevious: true, hasNext: true, processedStep: 1 };
      catchUp();
      expect(pager.uiSteps.value).toBe(1);
      expect(deadlines).toEqual([
        { delayMs: RELEASE_ART_DEADLINE_MS, reduceMotion: 'never', finish: expect.any(Function) },
      ]);
      // A second delivery does not start the clock over.
      catchUp();
      expect(deadlines).toHaveLength(1);

      vi.setSystemTime(10_000 + 3 * RELEASE_ART_DEADLINE_MS);
      passDeadline();
      catchUp();
      expect(pager.uiSteps.value).toBe(2);
      expect(pager.noteStepArtWait).toHaveBeenCalledExactlyOnceWith(2, {
        artState: 'loading',
        waitedMs: 3 * RELEASE_ART_DEADLINE_MS,
      });
      landFling();
      expect(pager.requestStep).toHaveBeenLastCalledWith(1, 2);
    });

    it('waits for a page React mounted late to paint, past 700 ms after finger-up (#6351)', () => {
      const { pager, pageArt, catchUp } = releaseWhileReactIsBehind({ 0: 'ready', 1: 'ready' });
      vi.setSystemTime(10_650);
      pager.jsState.value = { center: 1, hasPrevious: true, hasNext: true, processedStep: 1 };
      catchUp();
      expect(pager.uiSteps.value).toBe(1);
      // The full 700 ms from the mount, not the 50 left of 700 from finger-up.
      expect(deadlines.map(({ delayMs }) => delayMs)).toEqual([RELEASE_ART_DEADLINE_MS]);

      // 700 ms after finger-up, but only 50 since the page was mounted: no bare page.
      vi.setSystemTime(10_700);
      catchUp();
      expect(pager.uiSteps.value).toBe(1);

      vi.setSystemTime(10_750);
      pageArt.value = { ...pageArt.value, 2: 'ready' };
      catchUp();
      expect(pager.uiSteps.value).toBe(2);
      expect(pager.noteStepArtWait).toHaveBeenCalledExactlyOnceWith(2, { artState: 'ready', waitedMs: 750 });
    });

    it('counts a release that waited past the deadline for React, even onto a painted board', () => {
      const { pager, pageArt, catchUp } = releaseWhileReactIsBehind({ 0: 'ready', 1: 'ready' });
      vi.setSystemTime(10_900);
      catchUp();
      pageArt.value = { ...pageArt.value, 2: 'ready' };
      pager.jsState.value = { center: 1, hasPrevious: true, hasNext: true, processedStep: 1 };
      catchUp();
      expect(pager.uiSteps.value).toBe(2);
      expect(deadlines).toHaveLength(0);
      expect(pager.noteStepArtWait).toHaveBeenCalledExactlyOnceWith(2, { artState: 'ready', waitedMs: 900 });
    });

    it('steps onto a board that failed before React acknowledged the step before it', () => {
      const { pager, pageArt, catchUp } = releaseWhileReactIsBehind({ 0: 'ready', 1: 'ready', 2: 'loading' });

      // Failure arrives before React acknowledges the first swipe's render: the
      // release still waits for React, and no longer for the board.
      pageArt.value = { ...pageArt.value, 2: 'failed' };
      catchUp();
      expect(pager.uiSteps.value).toBe(1);
      pager.jsState.value = { center: 1, hasPrevious: true, hasNext: true, processedStep: 1 };
      catchUp();

      expect(pager.uiSteps.value).toBe(2);
      expect(pager.noteStepArtWait).toHaveBeenCalledExactlyOnceWith(2, { artState: 'failed', waitedMs: 0 });
      // A later repair starts no second fling.
      pageArt.value = { ...pageArt.value, 2: 'ready' };
      catchUp();
      landFling();
      expect(pager.uiSteps.value).toBe(2);
      expect(pager.anchorPage.value).toBe(2);
      expect(pager.requestStep).toHaveBeenCalledTimes(2);
      expect(pager.requestStep).toHaveBeenLastCalledWith(1, 2);
    });

    it('steps once onto a board repaired before React acknowledged the step before it', () => {
      const { pager, pageArt, catchUp } = releaseWhileReactIsBehind({ 0: 'ready', 1: 'ready', 2: 'loading' });
      pageArt.value = { ...pageArt.value, 2: 'failed' };
      catchUp();
      pageArt.value = { ...pageArt.value, 2: 'ready' };
      catchUp();
      expect(pager.uiSteps.value).toBe(1);

      pager.jsState.value = { center: 1, hasPrevious: true, hasNext: true, processedStep: 1 };
      catchUp();
      catchUp();

      expect(pager.uiSteps.value).toBe(2);
      expect(springCallbacks).toHaveLength(1);
      // It painted in time: nothing to count.
      expect(pager.noteStepArtWait).not.toHaveBeenCalled();
    });
  });

  it('springs back without committing below the threshold', () => {
    const pager = makePager();
    renderHook(() => useCarouselGesture(makeOptions({ pager })));

    swipe(latestHandlers(), -(SWIPE_THRESHOLD - 1));

    expect(pager.uiSteps.value).toBe(0);
    expect(pager.untoldStep.value).toBe(0);
    expect(pager.translateX.value).toBe(0);
    expect(pager.anchorPage.value).toBe(0);
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

  it('ignores old finger travel when navigation resets after the final update', () => {
    const pager = makePager();
    renderHook(() => useCarouselGesture(makeOptions({ pager })));
    const handlers = latestHandlers();
    handlers.onStart({ translationX: 0 });
    handlers.onUpdate({ translationX: -(SWIPE_THRESHOLD + 1) });
    pager.resetGeneration.value += 1;
    pager.translateX.value = 0;
    handlers.onEnd({ translationX: -(SWIPE_THRESHOLD + 1), velocityX: -1200 });
    expect(pager.uiSteps.value).toBe(0);
    expect(pager.isAnimating.value).toBe(false);
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

  describe('a carousel taken down while the pager is in use', () => {
    it('returns a drag to rest: no release will ever come for it', () => {
      const pager = makePager();
      const { unmount } = renderHook(() => useCarouselGesture(makeOptions({ pager })));
      const handlers = latestHandlers();
      handlers.onStart({ translationX: 0 });
      handlers.onUpdate({ translationX: -60 });
      expect(pager.translateX.value).toBe(-60);

      unmount();

      // Left there, the header would sit off centre and the pull-down would stand aside.
      expect(cancelAnimation).toHaveBeenCalledWith(pager.translateX);
      expect(pager.translateX.value).toBe(0);
    });

    it('leaves a fling to land by itself, and the step it carries still reaches the JS thread', () => {
      const pager = makePager();
      const { unmount } = renderHook(() => useCarouselGesture(makeOptions({ pager })));
      swipe(latestHandlers(), -(SWIPE_THRESHOLD + 1));

      unmount();

      expect(cancelAnimation).not.toHaveBeenCalled();
      expect(pager.translateX.value).toBe(-FLING_TARGET);
      expect(pager.flingDirection.value).toBe(1);

      landFling();
      expect(pager.requestStep).toHaveBeenCalledExactlyOnceWith(1, 1);
      expect(pager.anchorPage.value).toBe(1);
      expect(pager.translateX.value).toBe(0);
    });

    // With the real pager and navigation hooks, since the step's own render can
    // be what takes the carousel down while the drawer goes on rendering. The
    // pager's UI-thread reactions are not driven in these tests: the step reaches
    // the JS thread because the fling lands, and where the anchor ends up is
    // the pager tests' business.
    it('changes the climb with the callbacks of the render the drawer made after the carousel went', () => {
      const whileTheCarouselWasUp = vi.fn();
      const afterItWentDown = vi.fn();
      const drawer = renderHook(
        ({ onNext }: { onNext: () => void }) => {
          const { pager, stepSignal } = useSwipePager();
          useSwipePages(pager, stepSignal, 'a', 'b', 'c');
          useSwipeNavigation(pager, onNext, onNext);
          return pager;
        },
        { initialProps: { onNext: whileTheCarouselWasUp } },
      );
      const pager = drawer.result.current;
      const carousel = renderHook(() => useCarouselGesture(makeOptions({ pager })));
      swipe(latestHandlers(), -(SWIPE_THRESHOLD + 1));

      carousel.unmount();
      drawer.rerender({ onNext: afterItWentDown });
      act(() => landFling());

      expect(whileTheCarouselWasUp).not.toHaveBeenCalled();
      expect(afterItWentDown).toHaveBeenCalledTimes(1);
      drawer.unmount();
    });

    it('lets the carousel mounted in its place take over the fling without losing the step', () => {
      const pager = makePager();
      const first = renderHook(() => useCarouselGesture(makeOptions({ pager })));
      swipe(latestHandlers(), -(SWIPE_THRESHOLD + 1));
      pager.translateX.value = -200;
      first.unmount();

      renderHook(() => useCarouselGesture(makeOptions({ pager })));
      expect(recordedBuilders).toHaveLength(2);
      // A touch on the new carousel, while the old one's fling is still running.
      latestHandlers().onStart({ translationX: -12 });

      // The step was the pager's to keep, so the new carousel could hand it over.
      expect(pager.requestStep).toHaveBeenCalledExactlyOnceWith(1, 1);
      expect(pager.anchorPage.value).toBe(1);
      expect(pager.translateX.value).toBe(120);
    });
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
      expect(pager.requestStep).toHaveBeenCalledExactlyOnceWith(1, 1);

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
      expect(pager.requestStep).toHaveBeenCalledTimes(2);
      expect(pager.requestStep).toHaveBeenLastCalledWith(1, 2);
      expect(pager.anchorPage.value).toBe(2);
    });

    it('waits on the page it reached until the JS thread has mounted the one after', () => {
      const pager = makePager();
      const { catchUp } = renderCarouselWithPendingReaction(makeOptions({ pager }));
      const handlers = latestHandlers();
      startFling(pager, handlers, -200);

      handlers.onStart({ translationX: -12 });
      handlers.onUpdate({ translationX: -60 });
      handlers.onEnd({ translationX: -60, velocityX: -2500 });

      // Page 2 does not exist yet. The second release waits; the first step stands.
      expect(pager.requestStep).toHaveBeenCalledExactlyOnceWith(1, 1);
      expect(pager.uiSteps.value).toBe(1);
      expect(pager.anchorPage.value).toBe(1);
      expect(pager.translateX.value).toBe(0);
      expect(pager.isAnimating.value).toBe(false);

      pager.jsState.value = { center: 1, hasPrevious: true, hasNext: true, processedStep: 1 };
      catchUp();
      expect(pager.uiSteps.value).toBe(2);
      expect(pager.flingDirection.value).toBe(1);
      expect(pager.isAnimating.value).toBe(true);
      expect(pager.translateX.value).toBe(-FLING_TARGET);

      // Re-delivery cannot start a second fling for the same retained release.
      const flingCount = springCallbacks.length;
      catchUp();
      expect(springCallbacks).toHaveLength(flingCount);
      expect(pager.uiSteps.value).toBe(2);
      landFling();
      catchUp();
      expect(pager.anchorPage.value).toBe(2);
      expect(pager.requestStep).toHaveBeenCalledTimes(2);
      expect(pager.requestStep).toHaveBeenLastCalledWith(1, 2);
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
