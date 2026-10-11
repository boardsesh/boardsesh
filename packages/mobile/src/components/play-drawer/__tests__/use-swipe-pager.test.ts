// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';

// What the UI thread does with the pager is a worklet; here it runs as plain
// functions over plain `{ value }` objects, and the reaction is captured so a
// test can fire it the way Reanimated would when `jsState` changes.
const reactions = vi.hoisted(() => [] as { prepare: () => unknown; react: (value: never) => void }[]);
const cancelAnimation = vi.hoisted(() => vi.fn());
vi.mock('react-native-reanimated', async () => {
  const { useRef } = await import('react');
  return {
    useSharedValue: (initial: unknown) => {
      const ref = useRef<{ value: unknown } | null>(null);
      if (ref.current === null) ref.current = { value: initial };
      return ref.current;
    },
    useAnimatedReaction: (prepare: () => unknown, react: (value: never) => void) => {
      reactions.push({ prepare, react });
    },
    cancelAnimation,
  };
});

import { nextCenterPage, pageOffset, useSwipePager, useSwipePages, type SwipePageAssignment } from '../use-swipe-pager';

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
    expect(pageOffset(4, 4, 0, WIDTH)).toEqual({ visible: true, offset: 0 });
    expect(pageOffset(5, 4, 0, WIDTH).visible).toBe(false);
    expect(pageOffset(3, 4, 0, WIDTH).visible).toBe(false);
  });

  it('moves the middle page with the finger', () => {
    expect(pageOffset(4, 4, -120, WIDTH)).toEqual({ visible: true, offset: -120 });
  });

  it('brings the next page in edge to edge and stops it in the middle', () => {
    expect(pageOffset(5, 4, -120, WIDTH)).toEqual({ visible: true, offset: 180 });
    expect(pageOffset(5, 4, -300, WIDTH)).toEqual({ visible: true, offset: 0 });
    // The outgoing page carries on past its own width; the incoming one does not follow.
    expect(pageOffset(5, 4, -470, WIDTH)).toEqual({ visible: true, offset: 0 });
    // The other neighbour stays out of it.
    expect(pageOffset(3, 4, -120, WIDTH).visible).toBe(false);
  });

  it('brings the previous page in from the other side', () => {
    expect(pageOffset(3, 4, 120, WIDTH)).toEqual({ visible: true, offset: -180 });
    expect(pageOffset(3, 4, 470, WIDTH)).toEqual({ visible: true, offset: 0 });
    expect(pageOffset(5, 4, 120, WIDTH).visible).toBe(false);
  });

  it('never draws a page further away than a neighbour', () => {
    expect(pageOffset(6, 4, -120, WIDTH).visible).toBe(false);
    expect(pageOffset(2, 4, 120, WIDTH).visible).toBe(false);
  });
});

type Ids = { previous: string | null; current: string | null; next: string | null };

function renderPager(initial: Ids) {
  return renderHook(
    (ids: Ids) => {
      const { pager, stepSignal } = useSwipePager();
      const centerPage = useSwipePages(pager, stepSignal, ids.previous, ids.current, ids.next);
      return { pager, centerPage };
    },
    { initialProps: initial },
  );
}

/** Fire the UI-thread reaction the way Reanimated does when `jsState` has changed. */
function runReaction() {
  const reaction = reactions[reactions.length - 1];
  reaction.react(reaction.prepare() as never);
}

describe('useSwipePager', () => {
  beforeEach(() => {
    reactions.length = 0;
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

    act(() => first.requestStep(1, 1, () => {}));
    rerender({ previous: 'b', current: 'c', next: 'd' });

    expect(result.current.pager).toBe(first);
  });

  it('follows a swipe step in the render that shows the new climb, and says which step that was', () => {
    const { result, rerender } = renderPager({ previous: 'a', current: 'b', next: 'c' });
    const { pager } = result.current;

    // The gesture's JS callback: note the step and change the climb, one batch.
    act(() => {
      pager.requestStep(1, 1, () => {});
      rerender({ previous: 'b', current: 'c', next: 'd' });
    });

    expect(result.current.centerPage).toBe(1);
    expect(pager.jsState.value).toEqual({ center: 1, hasPrevious: true, hasNext: true, processedStep: 1 });
  });

  it('keeps counting pages from where the last committed render left them', () => {
    const { result, rerender } = renderPager({ previous: 'a', current: 'b', next: 'c' });
    const { pager } = result.current;

    act(() => {
      pager.requestStep(1, 1, () => {});
      rerender({ previous: 'b', current: 'c', next: 'd' });
    });
    act(() => {
      pager.requestStep(1, 2, () => {});
      rerender({ previous: 'c', current: 'd', next: null });
    });
    act(() => {
      pager.requestStep(-1, 3, () => {});
      rerender({ previous: 'b', current: 'c', next: 'd' });
    });

    expect(result.current.centerPage).toBe(1);
    expect(pager.jsState.value).toEqual({ center: 1, hasPrevious: true, hasNext: true, processedStep: 3 });
  });

  it('runs one step per committed render, so the second acts on what the first left', async () => {
    // The climbs live in state here, as the queue's do: a navigation is a state
    // update in the same batch as the step it belongs to.
    const { result } = renderHook(() => {
      const [ids, setIds] = useState<Ids>({ previous: 'a', current: 'b', next: 'c' });
      const { pager, stepSignal } = useSwipePager();
      const centerPage = useSwipePages(pager, stepSignal, ids.previous, ids.current, ids.next);
      return { pager, centerPage, setIds };
    });
    const { pager, setIds } = result.current;
    let pageWhenBackRan: number | null = null;
    const forward = vi.fn(() => setIds({ previous: 'b', current: 'c', next: 'd' }));
    const back = vi.fn(() => {
      // What the JS thread had reported as rendered when this step's turn came.
      pageWhenBackRan = pager.jsState.value.center;
      setIds({ previous: 'a', current: 'b', next: 'c' });
    });

    // The JS thread was busy: a swipe forward and a swipe back both arrive before it renders.
    // Async, because the second step starts from an effect and renders after it.
    await act(async () => {
      pager.requestStep(1, 1, forward);
      pager.requestStep(-1, 2, back);
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
    const { result } = renderPager({ previous: 'a', current: 'b', next: 'c' });
    const { pager } = result.current;
    const second = vi.fn();

    await act(async () => {
      pager.requestStep(1, 1, () => {});
      pager.requestStep(1, 2, second);
    });

    // Nothing changed for step 1, but its render committed all the same.
    expect(second).toHaveBeenCalledTimes(1);
    expect(pager.jsState.value.processedStep).toBe(2);
  });

  it('reports a step the queue refused, so the UI thread can go back', () => {
    const { result } = renderPager({ previous: 'a', current: 'b', next: 'c' });
    const { pager } = result.current;

    act(() => pager.requestStep(1, 1, () => {}));

    expect(result.current.centerPage).toBe(0);
    expect(pager.jsState.value.processedStep).toBe(1);
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
        pager.requestStep(1, 1, () => {});
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
        pager.requestStep(1, 1, () => {});
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

      act(() => pager.requestStep(1, 1, () => {}));
      runReaction();

      expect(pager.anchorPage.value).toBe(0);
      expect(pager.isAnimating.value).toBe(false);
      expect(pager.flingDirection.value).toBe(0);
    });
  });
});
