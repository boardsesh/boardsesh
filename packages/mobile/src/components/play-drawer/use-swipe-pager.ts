import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cancelAnimation, useAnimatedReaction, useSharedValue, type SharedValue } from 'react-native-reanimated';

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
 * 66 ms on an iPhone 13 Pro from when it is told; a swipe back never does.
 *
 * The JS thread takes the steps one at a time (`requestStep`). Two of them can
 * be waiting when it has been busy, and the navigation callbacks read state that
 * only a render brings up to date: run back to back, the second would act on
 * the climb the first had already left.
 */

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
  /** True from a committing release until the outgoing board is off screen. */
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
  /** Bumped each time the UI thread abandons what it was doing to follow the JS thread. A drag in progress starts over. */
  resetGeneration: SharedValue<number>;
  /**
   * JS thread. Take a step the UI thread took: `navigate` changes the climb.
   * Steps are run one per committed render, in order.
   */
  requestStep: (direction: 1 | -1, step: number, navigate: () => void) => void;
  /** JS thread. A render that reflects swipe step `step` has committed. */
  stepRendered: (step: number) => void;
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
  const resetGeneration = useSharedValue(0);

  const [stepSignal, setStepSignal] = useState<SwipeStepSignal>({ direction: 0, step: 0 });
  // Steps the UI thread has taken that the JS thread has not started on, and
  // the one whose render it is waiting for. `setStepSignal` and `navigate` are
  // one batch, so the render that shows the new climb is also the one that
  // reports the step as rendered.
  const waitingStepsRef = useRef<{ direction: 1 | -1; step: number; navigate: () => void }[]>([]);
  const stepInFlightRef = useRef<number | null>(null);
  const startNextStep = useCallback(() => {
    if (stepInFlightRef.current !== null) return;
    const next = waitingStepsRef.current.shift();
    if (!next) return;
    stepInFlightRef.current = next.step;
    setStepSignal({ direction: next.direction, step: next.step });
    next.navigate();
  }, []);
  const requestStep = useCallback(
    (direction: 1 | -1, step: number, navigate: () => void) => {
      waitingStepsRef.current.push({ direction, step, navigate });
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
      resetGeneration,
      requestStep,
      stepRendered,
    }),
    [
      translateX,
      isAnimating,
      anchorPage,
      flingDirection,
      uiSteps,
      jsState,
      slideWidth,
      resetGeneration,
      requestStep,
      stepRendered,
    ],
  );

  return { pager, stepSignal };
}

/**
 * The page the current climb is on, for this render, and the report of it to the
 * UI thread once the render has committed.
 *
 * `previousId`, `currentId` and `nextId` identify the three climbs by something
 * that survives the climb becoming current: a climb uuid, not a queue-item uuid,
 * because a suggestion is given a new queue item when it is swiped onto.
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
 * Where a page's content sits, for a board or header `slideWidth` wide.
 *
 * The page in the middle follows the finger. Its neighbour on the side being
 * swiped towards enters edge to edge with it and stops in the middle while the
 * outgoing page carries on off screen. Every other page is parked out of sight,
 * so at rest only the middle page is drawn.
 */
export function pageOffset(
  page: number,
  anchorPage: number,
  translateX: number,
  slideWidth: number,
): { visible: boolean; offset: number } {
  'worklet';
  const relative = page - anchorPage;
  if (relative === 0) return { visible: true, offset: translateX };
  if (relative === 1 && translateX < 0) return { visible: true, offset: Math.max(0, slideWidth + translateX) };
  if (relative === -1 && translateX > 0) return { visible: true, offset: Math.min(0, -slideWidth + translateX) };
  return { visible: false, offset: slideWidth };
}
