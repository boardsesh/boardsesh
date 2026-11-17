// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';

// What the UI thread does with the pager is a worklet; here it runs as plain
// functions over plain `{ value }` objects, and the two reactions are captured
// so a test can fire them the way Reanimated would when their inputs change.
// Each render registers both again, in the hook's order: "has the incoming board
// stopped", then "what has the JS thread rendered".
const reactions = vi.hoisted(() => [] as { prepare: () => unknown; react: (value: never, before: never) => void }[]);
const cancelAnimation = vi.hoisted(() => vi.fn());
vi.mock('react-native-reanimated', async () => {
  const { useRef } = await import('react');
  return {
    useSharedValue: (initial: unknown) => {
      const ref = useRef<{ value: unknown } | null>(null);
      if (ref.current === null) ref.current = { value: initial };
      return ref.current;
    },
    useAnimatedReaction: (prepare: () => unknown, react: (value: never, before: never) => void) => {
      reactions.push({ prepare, react });
    },
    cancelAnimation,
    runOnJS:
      (fn: (...args: unknown[]) => unknown) =>
      (...args: unknown[]) =>
        fn(...args),
  };
});

import {
  nextCenterPage,
  PAGE_MAX_STRETCH,
  pageOffset,
  useSwipeNavigation,
  useSwipePager,
  useSwipePages,
  type SwipePageAssignment,
  type SwipePager,
} from '../use-swipe-pager';

function assignment(overrides: Partial<SwipePageAssignment> = {}): SwipePageAssignment {
  return { previousId: 'a', currentId: 'b', nextId: 'c', center: 7, step: 0, ...overrides };
}

describe('nextCenterPage', () => {
  it('keeps the page when the current climb did not change', () => {
    expect(nextCenterPage(assignment(), 'b', 0)).toBe(7);
  });

  it('follows the current climb onto the page its board is already mounted on', () => {
    expect(nextCenterPage(assignment(), 'c', 0)).toBe(8);
    expect(nextCenterPage(assignment(), 'a', 0)).toBe(6);
  });

  it('puts a climb that was not a neighbour on the middle page, in place of the old one', () => {
    expect(nextCenterPage(assignment(), 'z', 0)).toBe(7);
    // A neighbour that was not there cannot be stepped onto.
    expect(nextCenterPage(assignment({ nextId: null }), 'c', 0)).toBe(7);
  });

  it('stays put while there is no current climb', () => {
    expect(nextCenterPage(assignment(), null, 1)).toBe(7);
  });

  it('tells a step from a standstill when the same climb is queued twice in a row', () => {
    const twice = assignment({ previousId: 'a', currentId: 'b', nextId: 'b' });
    // Nothing was swiped: the climb in the middle is the one that was there.
    expect(nextCenterPage(twice, 'b', 0)).toBe(7);
    // A swipe forward landed on the second copy, which has its own board.
    expect(nextCenterPage(twice, 'b', 1)).toBe(8);
    expect(nextCenterPage(assignment({ previousId: 'b', currentId: 'b', nextId: 'c' }), 'b', -1)).toBe(6);
  });

  it('ignores a step that did not land where it was heading', () => {
    // Swiped forward, but the queue put something else there.
    expect(nextCenterPage(assignment(), 'z', 1)).toBe(7);
    expect(nextCenterPage(assignment(), 'b', 1)).toBe(7);
  });
});

describe('pageOffset', () => {
  const WIDTH = 300;

  it('draws only the middle page at rest', () => {
    expect(pageOffset(4, 4, 0, WIDTH)).toEqual({ visible: true, offset: 0, opacity: 1 });
    expect(pageOffset(5, 4, 0, WIDTH).visible).toBe(false);
    expect(pageOffset(3, 4, 0, WIDTH).visible).toBe(false);
  });

  it('moves the middle page with the finger', () => {
    expect(pageOffset(4, 4, -120, WIDTH)).toEqual({ visible: true, offset: -120, opacity: 1 });
  });

  it('brings the next page in edge to edge and lands it in the middle', () => {
    expect(pageOffset(5, 4, -120, WIDTH)).toEqual({ visible: true, offset: 180, opacity: 1 });
    // The swipe settles at one board width: the incoming page is home, the
    // outgoing one is gone.
    expect(pageOffset(5, 4, -300, WIDTH)).toEqual({ visible: true, offset: 0, opacity: 1 });
    expect(pageOffset(4, 4, -300, WIDTH).visible).toBe(false);
    // A drag further than that changes nothing.
    expect(pageOffset(5, 4, -470, WIDTH)).toEqual({ visible: true, offset: 0, opacity: 1 });
    // The other neighbour stays out of it.
    expect(pageOffset(3, 4, -120, WIDTH).visible).toBe(false);
  });

  it('brings the previous page in from the other side', () => {
    expect(pageOffset(3, 4, 120, WIDTH)).toEqual({ visible: true, offset: -180, opacity: 1 });
    expect(pageOffset(3, 4, 470, WIDTH)).toEqual({ visible: true, offset: 0, opacity: 1 });
    expect(pageOffset(5, 4, 120, WIDTH).visible).toBe(false);
  });

  it('never draws a page further away than a neighbour', () => {
    expect(pageOffset(6, 4, -120, WIDTH).visible).toBe(false);
    expect(pageOffset(2, 4, 120, WIDTH).visible).toBe(false);
  });

  describe('a letterboxed board', () => {
    // A 335 pt board in a 402 pt frame: 33.5 pt margins, and 368.5 pt to leave it.
    const BOARD = 335;
    const EXIT = (402 + BOARD) / 2;

    it.each([-1, 1])(
      'takes the outgoing board out of the frame, margins and all, as the swipe lands (%s)',
      (direction) => {
        // The board used to stop at 335 pt with 33.5 pt of it still in the margin,
        // then vanish when the anchor moved.
        expect(pageOffset(4, 4, -direction * BOARD * 0.999, BOARD, EXIT).offset).toBeCloseTo(-direction * EXIT, 0);
        expect(pageOffset(4 + direction, 4, -direction * BOARD, BOARD, EXIT)).toEqual({
          visible: true,
          offset: 0,
          opacity: 1,
        });
      },
    );

    it('moves the board in the middle exactly with the finger as the swipe starts', () => {
      const offset = (translateX: number) => pageOffset(4, 4, translateX, BOARD, EXIT).offset;
      expect((offset(-1) - offset(0)) / -1).toBeCloseTo(1, 2);
    });

    it('brings the incoming board in from the frame’s edge, not from inside the margin', () => {
      expect(pageOffset(5, 4, -0.001, BOARD, EXIT).offset).toBeCloseTo(EXIT, 0);
    });

    it('never lets the two boards overlap', () => {
      for (let translateX = -5; translateX > -BOARD; translateX -= 5) {
        const outgoing = pageOffset(4, 4, translateX, BOARD, EXIT).offset;
        const incoming = pageOffset(5, 4, translateX, BOARD, EXIT).offset;
        expect(incoming - outgoing).toBeGreaterThanOrEqual(BOARD);
      }
    });

    it('never fades the board on a phone', () => {
      for (let translateX = 0; translateX >= -BOARD; translateX -= 5) {
        for (const page of [4, 5]) {
          const { visible, opacity } = pageOffset(page, 4, translateX, BOARD, EXIT);
          if (visible) expect(opacity).toBe(1);
        }
      }
    });

    it.each([-1, 1])('keeps both boards where they were when a swipe takes over a fling (%s)', (direction) => {
      // landFling(true): the anchor moves on and the offset is re-based by a board width.
      const before = -direction * BOARD * 0.6;
      const after = before + direction * BOARD;
      expect(pageOffset(4 + direction, 4 + direction, after, BOARD, EXIT).offset).toBeCloseTo(
        pageOffset(4 + direction, 4, before, BOARD, EXIT).offset,
        9,
      );
      expect(pageOffset(4, 4 + direction, after, BOARD, EXIT).offset).toBeCloseTo(
        pageOffset(4, 4, before, BOARD, EXIT).offset,
        9,
      );
    });
  });
});

describe('pageOffset in a wide frame', () => {
  // An iPad, or a phone on its side: a 600 pt board in a 1,100 pt frame leaves
  // 250 pt margins. Stretching the paths across them opened up to 125 pt of
  // empty frame between the boards, with the incoming one at 1.8 times the finger.
  const BOARD = 600;
  const EXIT = (1100 + BOARD) / 2;

  it('stretches the paths no more than on a phone', () => {
    for (let translateX = -10; translateX > -BOARD; translateX -= 10) {
      const outgoing = pageOffset(4, 4, translateX, BOARD, EXIT).offset;
      const incoming = pageOffset(5, 4, translateX, BOARD, EXIT).offset;
      expect(incoming - outgoing - BOARD).toBeLessThanOrEqual(PAGE_MAX_STRETCH);
    }
    // The finger's pace at the start, and no more than (1 + 2·48/600) of it at the end.
    const speed = (page: number, translateX: number) =>
      (pageOffset(page, 4, translateX - 1, BOARD, EXIT).offset - pageOffset(page, 4, translateX, BOARD, EXIT).offset) /
      -1;
    expect(speed(4, -1)).toBeCloseTo(1, 1);
    expect(speed(5, -2)).toBeLessThanOrEqual(1 + (2 * PAGE_MAX_STRETCH) / BOARD + 0.01);
  });

  it('fades the boards out of the margin they cannot cross, and in from it', () => {
    // Halfway: both whole.
    expect(pageOffset(4, 4, -300, BOARD, EXIT).opacity).toBe(1);
    expect(pageOffset(5, 4, -300, BOARD, EXIT).opacity).toBe(1);
    // The outgoing board is gone by the time the incoming one lands, and the
    // incoming one starts from nothing.
    expect(pageOffset(4, 4, -BOARD * 0.999, BOARD, EXIT).opacity).toBeCloseTo(0, 2);
    expect(pageOffset(5, 4, -BOARD * 0.001, BOARD, EXIT).opacity).toBeCloseTo(0, 2);
    expect(pageOffset(5, 4, -BOARD, BOARD, EXIT)).toEqual({ visible: true, offset: 0, opacity: 1 });
  });
});

type Ids = { previous: string | null; current: string | null; next: string | null };
type Navigation = { onNext?: () => void; onPrevious?: () => void };

const noNavigation = () => {};

/** The drawer's three calls: the pager, the pages, and its Next and Previous. */
function renderPager(initial: Ids & Navigation) {
  return renderHook(
    ({ onNext = noNavigation, onPrevious = noNavigation, ...ids }: Ids & Navigation) => {
      const { pager, stepSignal } = useSwipePager();
      const centerPage = useSwipePages(pager, stepSignal, ids.previous, ids.current, ids.next);
      useSwipeNavigation(pager, onNext, onPrevious);
      return { pager, centerPage };
    },
    { initialProps: initial },
  );
}

/** Fire the UI-thread reaction the way Reanimated does when `jsState` has changed. */
function runReaction() {
  const reaction = reactions[reactions.length - 1];
  reaction.react(reaction.prepare() as never, null as never);
}

/** What the "incoming board has stopped" reaction last saw, as Reanimated would hand it back. */
let stoppedBefore: boolean | null = null;
/** Put the outgoing board `offset` along its fling, then run that reaction as a frame would. */
function flingReaches(pager: SwipePager, offset: number) {
  pager.translateX.value = offset;
  const reaction = reactions[reactions.length - 2];
  const now = reaction.prepare() as boolean;
  reaction.react(now as never, stoppedBefore as never);
  stoppedBefore = now;
}
/** What the gesture does at a committing release, as far as the pager is concerned. */
function startFling(pager: SwipePager, direction: 1 | -1) {
  pager.uiSteps.value += 1;
  pager.untoldStep.value = pager.uiSteps.value;
  pager.isAnimating.value = true;
  pager.flingDirection.value = direction;
}

describe('useSwipePager', () => {
  beforeEach(() => {
    reactions.length = 0;
    stoppedBefore = null;
    cancelAnimation.mockClear();
  });

  it('reports the rendered climbs to the UI thread once the render has committed', () => {
    const { result } = renderPager({ previous: null, current: 'b', next: 'c' });

    expect(result.current.centerPage).toBe(0);
    expect(result.current.pager.jsState.value).toEqual({
      center: 0,
      hasPrevious: false,
      hasNext: true,
      processedStep: 0,
    });
  });

  it('keeps one pager object for the life of the mount', () => {
    const { result, rerender } = renderPager({ previous: 'a', current: 'b', next: 'c' });
    const first = result.current.pager;

    act(() => first.requestStep(1, 1));
    rerender({ previous: 'b', current: 'c', next: 'd' });

    expect(result.current.pager).toBe(first);
  });

  it('follows a swipe step in the render that shows the new climb, and says which step that was', () => {
    const { result, rerender } = renderPager({ previous: 'a', current: 'b', next: 'c' });
    const { pager } = result.current;

    // The gesture's JS callback: note the step and change the climb, one batch.
    act(() => {
      pager.requestStep(1, 1);
      rerender({ previous: 'b', current: 'c', next: 'd' });
    });

    expect(result.current.centerPage).toBe(1);
    expect(pager.jsState.value).toEqual({ center: 1, hasPrevious: true, hasNext: true, processedStep: 1 });
  });

  it('keeps counting pages from where the last committed render left them', () => {
    const { result, rerender } = renderPager({ previous: 'a', current: 'b', next: 'c' });
    const { pager } = result.current;

    act(() => {
      pager.requestStep(1, 1);
      rerender({ previous: 'b', current: 'c', next: 'd' });
    });
    act(() => {
      pager.requestStep(1, 2);
      rerender({ previous: 'c', current: 'd', next: null });
    });
    act(() => {
      pager.requestStep(-1, 3);
      rerender({ previous: 'b', current: 'c', next: 'd' });
    });

    expect(result.current.centerPage).toBe(1);
    expect(pager.jsState.value).toEqual({ center: 1, hasPrevious: true, hasNext: true, processedStep: 3 });
  });

  it('runs one step per committed render, so the second acts on what the first left', async () => {
    // The climbs live in state here, as the queue's do: a navigation is a state
    // update in the same batch as the step it belongs to.
    let pageWhenBackRan: number | null = null;
    const forward = vi.fn((setIds: (ids: Ids) => void) => setIds({ previous: 'b', current: 'c', next: 'd' }));
    const back = vi.fn((setIds: (ids: Ids) => void, pager: SwipePager) => {
      // What the JS thread had reported as rendered when this step's turn came.
      pageWhenBackRan = pager.jsState.value.center;
      setIds({ previous: 'a', current: 'b', next: 'c' });
    });
    const { result } = renderHook(() => {
      const [ids, setIds] = useState<Ids>({ previous: 'a', current: 'b', next: 'c' });
      const { pager, stepSignal } = useSwipePager();
      const centerPage = useSwipePages(pager, stepSignal, ids.previous, ids.current, ids.next);
      useSwipeNavigation(
        pager,
        () => forward(setIds),
        () => back(setIds, pager),
      );
      return { pager, centerPage };
    });
    const { pager } = result.current;

    // The JS thread was busy: a swipe forward and a swipe back both arrive before it renders.
    // Async, because the second step starts from an effect and renders after it.
    await act(async () => {
      pager.requestStep(1, 1);
      pager.requestStep(-1, 2);
      expect(forward).toHaveBeenCalledTimes(1);
      // Not yet: the queue would hand it the climb the first step has already left.
      expect(back).not.toHaveBeenCalled();
    });

    // It ran once the first step's render had committed, and saw that render.
    expect(back).toHaveBeenCalledTimes(1);
    expect(pageWhenBackRan).toBe(1);
    expect(result.current.centerPage).toBe(0);
    expect(pager.jsState.value).toEqual({ center: 0, hasPrevious: true, hasNext: true, processedStep: 2 });
  });

  it('moves on to the next step even when the queue refused the one before', async () => {
    const onNext = vi.fn();
    const onPrevious = vi.fn();
    const { result } = renderPager({ previous: 'a', current: 'b', next: 'c', onNext, onPrevious });
    const { pager } = result.current;

    await act(async () => {
      pager.requestStep(1, 1);
      pager.requestStep(-1, 2);
    });

    // Nothing changed for step 1, but its render committed all the same.
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onPrevious).toHaveBeenCalledTimes(1);
    expect(pager.jsState.value.processedStep).toBe(2);
  });

  it('changes the climb with the callbacks of the latest render, not the one the finger lifted in', () => {
    const atFingerUp = vi.fn();
    const afterAnotherRender = vi.fn();
    const ids = { previous: 'a', current: 'b', next: 'c' };
    const { result, rerender } = renderPager({ ...ids, onNext: atFingerUp });
    const { pager } = result.current;

    // The drawer rendered again before the fling had got far enough to tell it.
    rerender({ ...ids, onNext: afterAnotherRender });
    act(() => pager.requestStep(1, 1));

    expect(atFingerUp).not.toHaveBeenCalled();
    expect(afterAnotherRender).toHaveBeenCalledTimes(1);
  });

  it('hands a step that went before its board had painted what that board was doing, and no other step', async () => {
    const onNext = vi.fn();
    const onPrevious = vi.fn();
    const { result } = renderPager({ previous: 'a', current: 'b', next: 'c', onNext, onPrevious });
    const { pager } = result.current;
    const painting = { artState: 'loading' as const, waitedMs: 700 };
    const failed = { artState: 'failed' as const, waitedMs: 0 };

    // The gesture notes the step at its fling, ahead of the step itself.
    await act(async () => {
      pager.noteStepArtWait(1, painting);
      pager.noteStepArtWait(3, failed);
      pager.requestStep(1, 1);
      pager.requestStep(1, 2);
      pager.requestStep(-1, 3);
      pager.requestStep(-1, 4);
    });

    expect(onNext.mock.calls).toEqual([[painting], [undefined]]);
    expect(onPrevious.mock.calls).toEqual([[failed], [undefined]]);
  });

  it('reports a step as rendered even when nothing can change the climb yet', () => {
    const { result } = renderHook(() => {
      const { pager, stepSignal } = useSwipePager();
      useSwipePages(pager, stepSignal, 'a', 'b', 'c');
      return pager;
    });

    act(() => result.current.requestStep(1, 1));

    // No Next or Previous was handed over. The UI thread still hears, and goes back.
    expect(result.current.jsState.value).toMatchObject({ center: 0, processedStep: 1 });
  });

  it('reports a step the queue refused, so the UI thread can go back', () => {
    const { result } = renderPager({ previous: 'a', current: 'b', next: 'c' });
    const { pager } = result.current;

    act(() => pager.requestStep(1, 1));

    expect(result.current.centerPage).toBe(0);
    expect(pager.jsState.value.processedStep).toBe(1);
  });

  describe('telling the JS thread about a fling', () => {
    const BOARD_WIDTH = 320;

    function renderMeasuredPager(navigation: Navigation = {}) {
      const rendered = renderPager({ previous: 'a', current: 'b', next: 'c', ...navigation });
      // The carousel's gesture writes this once the board is measured.
      rendered.result.current.pager.slideWidth.value = BOARD_WIDTH;
      return rendered;
    }

    it('waits until the incoming board is all but home, and tells it once', () => {
      const onNext = vi.fn();
      const { result } = renderMeasuredPager({ onNext });
      const { pager } = result.current;

      startFling(pager, 1);
      // Finger-up: nothing yet. Changing the climb can cost the UI thread a
      // frame, and both boards are moving fast.
      act(() => flingReaches(pager, -40));
      act(() => flingReaches(pager, -(BOARD_WIDTH - 80)));
      act(() => flingReaches(pager, -(BOARD_WIDTH - 33)));
      expect(onNext).not.toHaveBeenCalled();

      // Within 10% of the middle: the settle is easing out.
      act(() => flingReaches(pager, -(BOARD_WIDTH - 32)));
      expect(onNext).toHaveBeenCalledTimes(1);
      expect(pager.untoldStep.value).toBe(0);
      // The anchor still waits for the spring to land.
      expect(pager.anchorPage.value).toBe(0);

      act(() => flingReaches(pager, -BOARD_WIDTH));
      act(() => pager.tellUntoldStep());
      expect(onNext).toHaveBeenCalledTimes(1);
    });

    it('tells it at once when the board was let go already past the middle', () => {
      const onNext = vi.fn();
      const { result } = renderMeasuredPager({ onNext });
      const { pager } = result.current;

      // Dragged further than the board is wide, then let go.
      act(() => flingReaches(pager, -(BOARD_WIDTH + 10)));
      startFling(pager, 1);
      act(() => flingReaches(pager, -(BOARD_WIDTH + 12)));

      expect(onNext).toHaveBeenCalledTimes(1);
    });

    it('steps back the same way', () => {
      const onPrevious = vi.fn();
      const { result } = renderMeasuredPager({ onPrevious });
      const { pager } = result.current;

      startFling(pager, -1);
      act(() => flingReaches(pager, BOARD_WIDTH));

      expect(onPrevious).toHaveBeenCalledTimes(1);
    });

    it('hands the step over when asked, for a fling that is cut short or lands untold', () => {
      const onNext = vi.fn();
      const { result } = renderMeasuredPager({ onNext });
      const { pager } = result.current;

      startFling(pager, 1);
      act(() => flingReaches(pager, -200));
      expect(onNext).not.toHaveBeenCalled();

      act(() => pager.tellUntoldStep());
      expect(onNext).toHaveBeenCalledTimes(1);
      // Nothing is left to tell.
      act(() => pager.tellUntoldStep());
      expect(onNext).toHaveBeenCalledTimes(1);
    });
  });

  describe('on the UI thread', () => {
    it('leaves a fling alone that is heading where the JS thread already is', () => {
      const { result, rerender } = renderPager({ previous: 'a', current: 'b', next: 'c' });
      const { pager } = result.current;
      // Finger-up: one step taken, the fling running.
      pager.uiSteps.value = 1;
      pager.isAnimating.value = true;
      pager.flingDirection.value = 1;
      pager.translateX.value = -150;

      act(() => {
        pager.requestStep(1, 1);
        rerender({ previous: 'b', current: 'c', next: 'd' });
      });
      runReaction();

      expect(pager.anchorPage.value).toBe(0);
      expect(pager.translateX.value).toBe(-150);
      expect(pager.isAnimating.value).toBe(true);
      expect(cancelAnimation).not.toHaveBeenCalled();
    });

    it('waits while the JS thread has not rendered every step', () => {
      const { result, rerender } = renderPager({ previous: 'a', current: 'b', next: 'c' });
      const { pager } = result.current;
      // Two swipes have landed; the JS thread has rendered only the first.
      pager.uiSteps.value = 2;
      pager.anchorPage.value = 2;

      act(() => {
        pager.requestStep(1, 1);
        rerender({ previous: 'b', current: 'c', next: 'd' });
      });
      runReaction();

      expect(pager.anchorPage.value).toBe(2);
    });

    it('goes where the JS thread is when a climb changed without a swipe', () => {
      const { result, rerender } = renderPager({ previous: 'a', current: 'b', next: 'c' });
      const { pager } = result.current;
      pager.translateX.value = -40;

      // The Next button, a queue tap, a crew member: no step was noted.
      rerender({ previous: 'b', current: 'c', next: 'd' });
      runReaction();

      expect(pager.anchorPage.value).toBe(1);
      expect(pager.translateX.value).toBe(0);
      expect(cancelAnimation).toHaveBeenCalledWith(pager.translateX);
      // A drag that was in progress has to take its bearings again.
      expect(pager.resetGeneration.value).toBe(1);
    });

    it('comes back from a step the queue refused', () => {
      const { result } = renderPager({ previous: 'a', current: 'b', next: 'c' });
      const { pager } = result.current;
      // The fling landed on page 1.
      pager.uiSteps.value = 1;
      pager.anchorPage.value = 1;

      act(() => pager.requestStep(1, 1));
      runReaction();

      expect(pager.anchorPage.value).toBe(0);
      expect(pager.isAnimating.value).toBe(false);
      expect(pager.flingDirection.value).toBe(0);
    });
  });
});
