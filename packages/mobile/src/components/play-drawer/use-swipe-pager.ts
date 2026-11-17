import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  cancelAnimation,
  runOnJS,
  useAnimatedReaction,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import type { BoardArtReadiness } from '../../lib/board-render/ready-board-art';

/**
 * Which climb sits in the middle of the play drawer's swipe, decided on the UI
 * thread.
 *
 * The drawer keeps three boards mounted: the climb on screen and its two
 * neighbours. Each lives on a numbered PAGE, and a page keeps its number for as
 * long as it is mounted. `anchorPage` is the page in the middle, and the swipe's
 * release animation moves it the frame the outgoing board is gone, without asking
 * the JS thread anything. The JS thread is told during the fling and follows: it
 * changes the climb, the pages shift one along, and the board that was the
 * neighbour is now the current one WITHOUT being remounted, because its page
 * number did not change.
 *
 * It used to be the other way round. One spare board held whichever neighbour
 * the JS thread last heard the swipe was heading for, so every swipe forward
 * began with the previous climb's holds on the incoming board, and a release was
 * followed by 160 to 230 ms (iPhone 13 Pro) in which the carousel ignored touches
 * while the JS thread swapped the climb under a frozen copy. At six swipes a
 * second half of them were lost.
 *
 * `uiSteps` and `jsState.processedStep` are how the two threads stay honest. The
 * UI thread numbers each step it takes; the JS thread writes back the last one it
 * has rendered. While they differ the JS thread is behind and the UI thread
 * leaves it alone. When they agree and the JS thread's middle page is not where
 * the swipes went (a Next button, a queue tap, a crew member's change, a step the
 * queue refused) the UI thread drops what it was doing and goes there.
 *
 * What the JS thread still decides is how far ahead a swipe may go: one page
 * either side of ITS middle page, because those are the boards it has mounted.
 * A second swipe the same way has to wait for it to render the first step, 30 to
 * 66 ms on an iPhone 13 Pro from when it is told; a swipe back needs no new
 * page mount. Either direction still waits for its neighbour’s native artwork.
 * A qualifying release is retained until the mounted neighbour’s background and
 * holds display (#6351), unless another touch or navigation replaces it, for at
 * most `RELEASE_ART_DEADLINE_MS` (700 ms) from when its page is mounted. A board that failed,
 * or is still painting by then, is stepped onto anyway: waiting on it held the
 * swipe for good, and the player had to be closed to go on.
 *
 * The JS thread takes the steps one at a time (`requestStep`). Two of them can
 * be waiting when it has been busy, and the navigation callbacks read state that
 * only a render brings up to date: run back to back, the second would act on
 * the climb the first had already left.
 *
 * Everything a step needs lives here, with the drawer, and not in the carousel:
 * the offset, the step a fling is carrying, and the callbacks that change the
 * climb. The board/carousel host stays mounted through geometry refinement
 * (#6383), including section-header changes (#6373). A fling or a step in
 * progress must still survive any carousel teardown, so its pending step and
 * callbacks belong to the pager.
 */

/**
 * A step that went before its page's board had painted, or after its release
 * waited past the deadline: what that board was doing then, and how long the
 * release had waited, in ms. Carried to the step's navigation callback for
 * `Queue Navigation`; an ordinary step carries none.
 */
export type SwipeArtWait = { artState: BoardArtReadiness; waitedMs: number };

/** What a swipe step calls to change the climb. `artWait` is set only on a step that went before its board had painted. */
export type SwipeStepNavigation = (artWait?: SwipeArtWait) => void;

/** What the JS thread has rendered. One object, so the UI thread never reads half an update. */
export type SwipePagerJsState = {
  /** The page holding the climb the JS thread shows as current. */
  center: number;
  hasPrevious: boolean;
  hasNext: boolean;
  /** The last swipe step the JS thread has rendered; equal to `uiSteps` once it has caught up. */
  processedStep: number;
};

export type SwipePager = {
  /** Horizontal offset of the page in the middle, in points. 0 at rest. */
  translateX: SharedValue<number>;
  /** True from a committing release until the incoming board has landed. */
  isAnimating: SharedValue<boolean>;
  /** The page in the middle, as the UI thread has it. */
  anchorPage: SharedValue<number>;
  /** +1 or -1 while a release animation is heading for the next or previous page, else 0. */
  flingDirection: SharedValue<number>;
  /** How many steps the UI thread has taken. */
  uiSteps: SharedValue<number>;
  jsState: SharedValue<SwipePagerJsState>;
  /**
   * How far the incoming board travels to reach the middle: the contained board
   * width, written by the carousel's gesture. 0 until the board is measured. The
   * header scales its own travel by it so the two arrive together.
   */
  slideWidth: SharedValue<number>;
  /** The current board uses an anchored GPU reveal; Reduce Motion keeps its title fixed. */
  stationaryMotion: SharedValue<boolean>;
  /** Bumped each time the UI thread abandons what it was doing to follow the JS thread. A drag in progress starts over. */
  resetGeneration: SharedValue<number>;
  /** The step a fling is carrying that the JS thread has not been told about yet; 0 when there is none. */
  untoldStep: SharedValue<number>;
  /** UI thread. Hand the step the fling is carrying to the JS thread, unless it has it already. */
  tellUntoldStep: () => void;
  /**
   * JS thread. Take a step the UI thread took, by calling the drawer's Next or
   * Previous. Steps are run one per committed render, in order.
   */
  requestStep: (direction: 1 | -1, step: number) => void;
  /** JS thread. A render that reflects swipe step `step` has committed. */
  stepRendered: (step: number) => void;
  /**
   * JS thread. Swipe step `step` went before its board had painted. Kept until
   * the step runs, and handed to its navigation callback. Told ahead of the
   * step itself, which only reaches the JS thread later in the fling.
   */
  noteStepArtWait: (step: number, artWait: SwipeArtWait) => void;
  /** JS thread. What a step calls to change the climb. See `useSwipeNavigation`. */
  setNavigation: (onNext: SwipeStepNavigation, onPrevious: SwipeStepNavigation) => void;
  /**
   * True while the climb on screen is the last on the list the player walks and
   * the end card is there to show (issue #6664). A forward swipe then gives a
   * little and, released past the threshold, shows the card instead of
   * springing back with nothing. Written by the drawer; see `useTrackEndSwipe`.
   */
  trackEndAvailable: SharedValue<boolean>;
  /** JS thread. A forward swipe was released past the list's end. */
  reachTrackEnd: () => void;
  /** JS thread. What `reachTrackEnd` runs. See `useTrackEndSwipe`. */
  setTrackEndHandler: (onTrackEnd: (() => void) | null) => void;
};

export type SwipePageAssignment = {
  previousId: string | null;
  currentId: string | null;
  nextId: string | null;
  center: number;
  step: number;
};

/**
 * The page the current climb is on, given the pages the last render used.
 *
 * A climb that was a neighbour keeps the page it was mounted on, which is what
 * lets its board stay mounted. `steppedDirection` is the swipe step this render
 * is answering, if any; it only matters when the same climb is queued twice in a
 * row, where "did not move" and "moved one along" look the same.
 */
export function nextCenterPage(
  before: SwipePageAssignment,
  currentId: string | null,
  steppedDirection: -1 | 0 | 1,
): number {
  if (currentId === null) return before.center;
  if (steppedDirection === 1 && currentId === before.nextId) return before.center + 1;
  if (steppedDirection === -1 && currentId === before.previousId) return before.center - 1;
  if (currentId === before.currentId) return before.center;
  if (currentId === before.nextId) return before.center + 1;
  if (currentId === before.previousId) return before.center - 1;
  // Somewhere else entirely: the new climb takes the middle page's place.
  return before.center;
}

export type SwipeStepSignal = { direction: -1 | 0 | 1; step: number };

/**
 * How far from the middle, as a share of the board's width, the incoming board
 * is when the JS thread is told about the step: 10%, about 34 pt on a phone.
 */
export const TELL_JS_REMAINING = 0.1;

/**
 * The pager's shared values, and the last swipe step the JS thread was told
 * about. Split from `useSwipePages` only so a component can create the values
 * before it knows the climbs: the drawer's dismiss gesture reads the offset, and
 * is set up above the queue lookups that name the neighbours.
 */
export function useSwipePager(): { pager: SwipePager; stepSignal: SwipeStepSignal } {
  const translateX = useSharedValue(0);
  const isAnimating = useSharedValue(false);
  const anchorPage = useSharedValue(0);
  const flingDirection = useSharedValue(0);
  const uiSteps = useSharedValue(0);
  const jsState = useSharedValue<SwipePagerJsState>({
    center: 0,
    hasPrevious: false,
    hasNext: false,
    processedStep: 0,
  });
  const slideWidth = useSharedValue(0);
  const stationaryMotion = useSharedValue(false);
  const resetGeneration = useSharedValue(0);
  const untoldStep = useSharedValue(0);
  const trackEndAvailable = useSharedValue(false);
  const trackEndHandlerRef = useRef<(() => void) | null>(null);
  const setTrackEndHandler = useCallback((onTrackEnd: (() => void) | null) => {
    trackEndHandlerRef.current = onTrackEnd;
  }, []);
  const reachTrackEnd = useCallback(() => {
    trackEndHandlerRef.current?.();
  }, []);

  const [stepSignal, setStepSignal] = useState<SwipeStepSignal>({ direction: 0, step: 0 });
  const navigationRef = useRef<{ onNext: SwipeStepNavigation; onPrevious: SwipeStepNavigation } | null>(null);
  const setNavigation = useCallback((onNext: SwipeStepNavigation, onPrevious: SwipeStepNavigation) => {
    navigationRef.current = { onNext, onPrevious };
  }, []);
  // Rare: only a step that went before its board had painted is noted.
  const artWaitsRef = useRef(new Map<number, SwipeArtWait>());
  const noteStepArtWait = useCallback((step: number, artWait: SwipeArtWait) => {
    artWaitsRef.current.set(step, artWait);
  }, []);
  // Steps the UI thread has taken that the JS thread has not started on, and
  // the one whose render it is waiting for. `setStepSignal` and the navigation
  // are one batch, so the render that shows the new climb is also the one that
  // reports the step as rendered.
  const waitingStepsRef = useRef<{ direction: 1 | -1; step: number }[]>([]);
  const stepInFlightRef = useRef<number | null>(null);
  const startNextStep = useCallback(() => {
    if (stepInFlightRef.current !== null) return;
    const next = waitingStepsRef.current.shift();
    if (!next) return;
    stepInFlightRef.current = next.step;
    setStepSignal({ direction: next.direction, step: next.step });
    const artWait = artWaitsRef.current.get(next.step);
    artWaitsRef.current.delete(next.step);
    // Looked up now, when the step's turn has come, not when the finger
    // lifted: these are the callbacks of the render the step before produced.
    const navigation = navigationRef.current;
    if (next.direction === 1) {
      navigation?.onNext(artWait);
    } else {
      navigation?.onPrevious(artWait);
    }
  }, []);
  const requestStep = useCallback(
    (direction: 1 | -1, step: number) => {
      waitingStepsRef.current.push({ direction, step });
      startNextStep();
    },
    [startNextStep],
  );
  const stepRendered = useCallback(
    (step: number) => {
      if (stepInFlightRef.current === null || step < stepInFlightRef.current) return;
      stepInFlightRef.current = null;
      startNextStep();
    },
    [startNextStep],
  );

  const tellUntoldStep = useCallback(() => {
    'worklet';
    const step = untoldStep.value;
    if (step === 0) return;
    untoldStep.value = 0;
    runOnJS(requestStep)(flingDirection.value > 0 ? 1 : -1, step);
  }, [untoldStep, flingDirection, requestStep]);
  // The JS thread is told once the incoming board is within `TELL_JS_REMAINING`
  // of a board width of the middle (34 pt on a 335 pt board): 8–42 ms after the
  // finger lifts from a flick, 58–83 ms after a slow release, never later than
  // when the old spring reached its clamp. Its render then lands while the settle
  // is easing out, and a second swipe that way finds its page mounted sooner.
  //
  // Changing the climb costs the UI thread a frame now and then (the new
  // neighbour's board is mounted, the rest of the drawer updates), and it
  // should not be a frame in which a board is moving fast. Told at finger-up it
  // was: 5 to 7 frames in 2,500 on an iPhone 13 Pro, all of them mid-fling.
  //
  // The anchored GPU board is unaffected by when the trio changes: the native
  // scene picks the same two pages and progress for (anchor, +0.9) as for
  // (anchor + 1, −0.1), so long as the new trio's previous climb is the one the
  // step left, as it is for every step forward and back.
  useAnimatedReaction(
    () => flingDirection.value !== 0 && Math.abs(translateX.value) >= slideWidth.value * (1 - TELL_JS_REMAINING),
    (incomingBoardHasStopped, before) => {
      if (incomingBoardHasStopped && !before) tellUntoldStep();
    },
  );

  useAnimatedReaction(
    () => jsState.value,
    (state) => {
      // The JS thread has not rendered every step yet. It writes again when it has.
      if (state.processedStep !== uiSteps.value) return;
      if (state.center === anchorPage.value + flingDirection.value) return;
      cancelAnimation(translateX);
      translateX.value = 0;
      flingDirection.value = 0;
      isAnimating.value = false;
      anchorPage.value = state.center;
      resetGeneration.value += 1;
    },
  );

  const pager = useMemo<SwipePager>(
    () => ({
      translateX,
      isAnimating,
      anchorPage,
      flingDirection,
      uiSteps,
      jsState,
      slideWidth,
      stationaryMotion,
      resetGeneration,
      untoldStep,
      tellUntoldStep,
      requestStep,
      stepRendered,
      noteStepArtWait,
      setNavigation,
      trackEndAvailable,
      reachTrackEnd,
      setTrackEndHandler,
    }),
    [
      translateX,
      isAnimating,
      anchorPage,
      flingDirection,
      uiSteps,
      jsState,
      slideWidth,
      stationaryMotion,
      resetGeneration,
      untoldStep,
      tellUntoldStep,
      requestStep,
      stepRendered,
      noteStepArtWait,
      setNavigation,
      trackEndAvailable,
      reachTrackEnd,
      setTrackEndHandler,
    ],
  );

  return { pager, stepSignal };
}

/**
 * The page the current climb is on, for this render, and the report of it to the
 * UI thread once the render has committed.
 *
 * `previousId`, `currentId` and `nextId` identify the three climbs by something
 * that survives the climb becoming current. The drawer passes the climb's uuid
 * and not the queue item's, because a suggestion is given a new queue item when
 * it is swiped onto. An id that does change under a swipe costs that one swipe
 * its mounted board and nothing else: the new climb takes the middle page.
 */
export function useSwipePages(
  pager: SwipePager,
  stepSignal: SwipeStepSignal,
  previousId: string | null,
  currentId: string | null,
  nextId: string | null,
): number {
  // Reads a ref during render, on purpose (below). React Compiler skips a
  // function that does; say so outright rather than lean on that.
  'use no memo';
  const { jsState, stepRendered } = pager;
  // The assignment the last COMMITTED render used. Written only after a commit,
  // so a render that React runs twice or throws away derives the same pages.
  const committedRef = useRef<SwipePageAssignment>({ previousId, currentId, nextId, center: 0, step: 0 });
  const committed = committedRef.current;
  const centerPage = nextCenterPage(
    committed,
    currentId,
    committed.step === stepSignal.step ? 0 : stepSignal.direction,
  );

  const processedStep = stepSignal.step;
  useEffect(() => {
    committedRef.current = { previousId, currentId, nextId, center: centerPage, step: processedStep };
    jsState.value = {
      center: centerPage,
      hasPrevious: previousId !== null,
      hasNext: nextId !== null,
      processedStep,
    };
    // Everything a navigation callback reads is up to date now: the next
    // waiting step, if there is one, may run.
    stepRendered(processedStep);
  }, [previousId, currentId, nextId, centerPage, processedStep, jsState, stepRendered]);

  return centerPage;
}

/**
 * What a swipe step calls to change the climb: the drawer's own Next and Previous.
 *
 * Handed over after every commit, ahead of `useSwipePages` letting the next
 * waiting step run, so a step always runs the callbacks of the render it
 * follows. They are the pager's rather than the carousel's because a fling can
 * outlive the carousel, and the step it carries must not change the climb with
 * the callbacks of a render that is gone.
 */
export function useSwipeNavigation(
  pager: SwipePager,
  onNext: SwipeStepNavigation,
  onPrevious: SwipeStepNavigation,
): void {
  const { setNavigation } = pager;
  useLayoutEffect(() => {
    setNavigation(onNext, onPrevious);
  }, [setNavigation, onNext, onPrevious]);
}

/**
 * Whether a forward swipe at the list's end shows the end card, and what it runs.
 *
 * `onTrackEnd` is null when there is no card to show (not at a list's end, or
 * more of the list is still loading); the swipe then stops dead, as it always
 * has. The shared value is written after commit, like the pages, so the UI
 * thread never offers a card the JS thread has already taken away.
 */
export function useTrackEndSwipe(pager: SwipePager, onTrackEnd: (() => void) | null): void {
  const { trackEndAvailable, setTrackEndHandler } = pager;
  useLayoutEffect(() => {
    setTrackEndHandler(onTrackEnd);
    trackEndAvailable.value = onTrackEnd !== null;
  }, [onTrackEnd, setTrackEndHandler, trackEndAvailable]);
}

/**
 * The most a board's path is stretched beyond its own width, in points: a phone's
 * letterbox margin (33.5 pt for a 335 pt board on a 402 pt screen) and more.
 * A wider margin (an iPad, or a phone on its side) is not crossed by stretching,
 * which left up to 125 pt of empty frame between the boards and the incoming
 * one moving at 1.8 times the finger; see `pageOffset`.
 */
export const PAGE_MAX_STRETCH = 48;

/**
 * The share of the swipe, at either end, over which a board fades when its
 * margin is wider than {@link PAGE_MAX_STRETCH}.
 */
export const PAGE_EDGE_FADE = 0.3;

/**
 * Where a board sits, for a board `slideWidth` wide in a frame that clips it
 * `exitWidth` from the middle (half the frame plus half the board).
 *
 * The swipe moves the offset between 0 and one board width, and settles there.
 * A page's distance from the middle, in board widths, is where it is drawn:
 * the middle page at the finger's offset, its neighbour one board width
 * further along. Far from the middle each page moves a little faster than the
 * finger, so the outgoing board has left the frame, letterbox margins and all,
 * at the moment the incoming one lands, and the incoming one enters from the
 * frame's edge rather than appearing inside the margin. In the middle a page
 * moves exactly with the finger. The gap between the two boards is the margin
 * at either end and half of it halfway.
 *
 * The stretch stops at {@link PAGE_MAX_STRETCH}. Past that the board would sit
 * in the margin when the swipe lands, so it fades out over the swipe's last
 * {@link PAGE_EDGE_FADE} instead, and the incoming one fades in over its first.
 *
 * Only the page in the middle and its neighbour on the side being swiped
 * towards are drawn, never more than one board width from the middle; at rest
 * only the middle page is.
 */
export function pageOffset(
  page: number,
  anchorPage: number,
  translateX: number,
  slideWidth: number,
  exitWidth: number = slideWidth,
): { visible: boolean; offset: number; opacity: number } {
  'worklet';
  if (!(slideWidth > 0)) {
    return page === anchorPage
      ? { visible: true, offset: translateX, opacity: 1 }
      : { visible: false, offset: 0, opacity: 0 };
  }
  // Clamped to one page: a drag past the board's width does not carry the
  // incoming board on past the middle, or bring a third.
  const progress = Math.max(-1, Math.min(1, translateX / slideWidth));
  const distance = page - anchorPage + progress;
  // Parked a board width along, out of sight, like every page at rest.
  if (Math.abs(distance) >= 1) return { visible: false, offset: slideWidth, opacity: 0 };
  const margin = Math.max(0, exitWidth - slideWidth);
  const stretch = Math.min(margin, PAGE_MAX_STRETCH);
  const opacity = margin > stretch ? Math.min(1, (1 - Math.abs(distance)) / PAGE_EDGE_FADE) : 1;
  return {
    visible: true,
    offset: distance * slideWidth + Math.sign(distance) * stretch * distance * distance,
    opacity,
  };
}
