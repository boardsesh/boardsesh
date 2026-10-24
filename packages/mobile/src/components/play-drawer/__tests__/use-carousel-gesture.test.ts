// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
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

import { useCarouselGesture } from '../use-carousel-gesture';
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
    setNavigation: vi.fn(),
  } as unknown as SwipePager & { requestStep: ReturnType<typeof vi.fn>; reachTrackEnd: ReturnType<typeof vi.fn> };
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
    it('does not offer end-card drag feedback while a real next climb is loading', async () => {
      const { hapticMedium } = await import('../../../lib/haptics');
      const pager = makePager({}, { trackEnd: true });
      const pageArt = shared<Readonly<Record<number, BoardArtReadiness>>>({ 0: 'ready', 1: 'loading' });
      renderCarouselWithPendingReaction(makeOptions({ pager, pageArt }));
      const handlers = latestHandlers();

      handlers.onStart({ translationX: 0 });
      handlers.onUpdate({ translationX: -(SWIPE_THRESHOLD + 1) });

      expect(pager.translateX.value).toBe(0);
      expect(hapticMedium).not.toHaveBeenCalled();
      handlers.onEnd({ translationX: -(SWIPE_THRESHOLD + 1), velocityX: -1200 });
      expect(pager.reachTrackEnd).not.toHaveBeenCalled();
      expect(pager.uiSteps.value).toBe(0);
    });

    it.each([1, -1] as const)('retains a release toward %s without exposing a bare board', (direction) => {
      const pager = makePager();
      const pageArt = shared<Readonly<Record<number, BoardArtReadiness>>>({ 0: 'ready', [direction]: 'loading' });
      const { catchUp } = renderCarouselWithPendingReaction(makeOptions({ pager, pageArt }));
      swipe(latestHandlers(), -direction * (SWIPE_THRESHOLD + 1));
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

    it.each(['React', 'artwork'] as const)('waits for both threads when %s catches up first', (first) => {
      const pager = makePager();
      const pageArt = shared<Readonly<Record<number, BoardArtReadiness>>>({ 0: 'ready', 1: 'ready', 2: 'loading' });
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
    });

    it.each(['touch', 'failure'] as const)('discards artwork-waiting intent after %s', (cancellation) => {
      const pager = makePager();
      const pageArt = shared<Readonly<Record<number, BoardArtReadiness>>>({ 0: 'ready', 1: 'loading' });
      const { catchUp } = renderCarouselWithPendingReaction(makeOptions({ pager, pageArt }));
      swipe(latestHandlers(), -(SWIPE_THRESHOLD + 1));
      if (cancellation === 'touch')
        latestHandlers().onTouchesDown({ allTouches: [{ absoluteX: 100, absoluteY: 100 }] });
      else pageArt.value = { ...pageArt.value, 1: 'failed' };
      catchUp();
      pageArt.value = { ...pageArt.value, 1: 'ready' };
      catchUp();
      expect(pager.uiSteps.value).toBe(0);
      expect(pager.isAnimating.value).toBe(false);
    });

    it('cancels retained intent after React acknowledges a step whose next artwork already failed', () => {
      const pager = makePager();
      const pageArt = shared<Readonly<Record<number, BoardArtReadiness>>>({ 0: 'ready', 1: 'ready', 2: 'loading' });
      const { catchUp } = renderCarouselWithPendingReaction(makeOptions({ pager, pageArt }));
      const handlers = latestHandlers();
      swipe(handlers, -(SWIPE_THRESHOLD + 1));
      landFling();
      swipe(handlers, -(SWIPE_THRESHOLD + 1));
      expect(pager.jsState.value.processedStep).toBe(0);
      expect(pager.uiSteps.value).toBe(1);

      // Failure arrives before React acknowledges the first swipe's render.
      pageArt.value = { ...pageArt.value, 2: 'failed' };
      catchUp();
      pager.jsState.value = { center: 1, hasPrevious: true, hasNext: true, processedStep: 1 };
      catchUp();
      expect(pager.uiSteps.value).toBe(1);
      expect(pager.isAnimating.value).toBe(false);

      // A later successful repair must not revive the cancelled release.
      pageArt.value = { ...pageArt.value, 2: 'ready' };
      catchUp();
      expect(pager.uiSteps.value).toBe(1);
      expect(pager.anchorPage.value).toBe(1);
      expect(pager.translateX.value).toBe(0);
      expect(pager.isAnimating.value).toBe(false);
      expect(springCallbacks).toHaveLength(0);
      expect(pager.requestStep).toHaveBeenCalledExactlyOnceWith(1, 1);
    });

    it('never revives a release when failed artwork recovers before React acknowledges its previous step', () => {
      const pager = makePager();
      const pageArt = shared<Readonly<Record<number, BoardArtReadiness>>>({ 0: 'ready', 1: 'ready', 2: 'loading' });
      const { catchUp } = renderCarouselWithPendingReaction(makeOptions({ pager, pageArt }));
      const handlers = latestHandlers();
      swipe(handlers, -(SWIPE_THRESHOLD + 1));
      landFling();
      swipe(handlers, -(SWIPE_THRESHOLD + 1));

      // The failure and repair both happen while React remains one step behind.
      pageArt.value = { ...pageArt.value, 2: 'failed' };
      catchUp();
      pageArt.value = { ...pageArt.value, 2: 'ready' };
      catchUp();
      expect(pager.jsState.value.processedStep).toBe(0);

      pager.jsState.value = { center: 1, hasPrevious: true, hasNext: true, processedStep: 1 };
      catchUp();

      expect(pager.uiSteps.value).toBe(1);
      expect(pager.anchorPage.value).toBe(1);
      expect(pager.translateX.value).toBe(0);
      expect(pager.isAnimating.value).toBe(false);
      expect(pager.requestStep).toHaveBeenCalledExactlyOnceWith(1, 1);
    });

    it('revokes drag access when a displayed neighbour starts a new artwork attempt', () => {
      const pager = makePager();
      const pageArt = shared<Readonly<Record<number, BoardArtReadiness>>>({ 0: 'ready', 1: 'ready' });
      renderCarouselWithPendingReaction(makeOptions({ pager, pageArt }));
      const handlers = latestHandlers();
      handlers.onStart({ translationX: 0 });
      handlers.onUpdate({ translationX: -30 });
      expect(pager.translateX.value).toBe(-30);
      pageArt.value = { 0: 'ready', 1: 'loading' };
      handlers.onUpdate({ translationX: -40 });
      expect(pager.translateX.value).toBe(0);
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
