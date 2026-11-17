// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { SwipePager, SwipePagerJsState } from '../use-swipe-pager';

// The reaction runs as plain functions over `{ value }` objects; a test fires it
// the way Reanimated would on a frame where its inputs changed.
const reactions = vi.hoisted(() => [] as { prepare: () => unknown; react: (now: never, before: never) => void }[]);
const timings = vi.hoisted(() => [] as { toValue: number; duration: number }[]);
vi.mock('react-native-reanimated', async () => {
  const { useRef } = await import('react');
  return {
    useSharedValue: (initial: unknown) => {
      const ref = useRef<{ value: unknown } | null>(null);
      if (ref.current === null) ref.current = { value: initial };
      return ref.current;
    },
    useAnimatedReaction: (prepare: () => unknown, react: (now: never, before: never) => void) => {
      reactions.push({ prepare, react });
    },
    useAnimatedStyle: (factory: () => unknown) => factory,
    // A fade resolves at once to its target; the test records that one started.
    withTiming: (toValue: number, config: { duration: number }) => {
      timings.push({ toValue, duration: config.duration });
      return toValue;
    },
  };
});

import { staleContentFrame, useSwipeStaleContentStyle } from '../use-swipe-stale-content';

const WIDTH = 320;
const at = (overrides: Partial<Parameters<typeof staleContentFrame>[0]> = {}) =>
  staleContentFrame({
    translateX: 0,
    slideWidth: WIDTH,
    flingDirection: 0,
    processedStep: 0,
    uiSteps: 0,
    ...overrides,
  });

describe('staleContentFrame', () => {
  it('shows the content at rest', () => {
    expect(at()).toEqual({ opacity: 1, follows: true });
  });

  it('fades it with the outgoing header while a drag moves, and back as it returns', () => {
    expect(at({ translateX: -80 })).toEqual({ opacity: 0.5, follows: true });
    expect(at({ translateX: -160 })).toEqual({ opacity: 0, follows: true });
    expect(at({ translateX: 80 })).toEqual({ opacity: 0.5, follows: true });
  });

  it('keeps fading it with a committed fling the JS thread has not rendered', () => {
    expect(at({ translateX: -40, flingDirection: 1, uiSteps: 1 })).toEqual({ opacity: 0.75, follows: true });
    expect(at({ translateX: -300, flingDirection: 1, uiSteps: 1 })).toEqual({ opacity: 0, follows: true });
  });

  it('hides it from the landing until the JS thread renders the step: it describes the climb that left', () => {
    // Landed: the offset is back to 0 around the new anchor, which alone would show it.
    expect(at({ translateX: 0, flingDirection: 0, processedStep: 0, uiSteps: 1 })).toEqual({
      opacity: 0,
      follows: false,
    });
  });

  it('brings it back once the step has rendered, even before the fling has landed', () => {
    expect(at({ translateX: -318, flingDirection: 1, processedStep: 1, uiSteps: 1 })).toEqual({
      opacity: 1,
      follows: false,
    });
    expect(at({ processedStep: 1, uiSteps: 1 })).toEqual({ opacity: 1, follows: true });
  });

  it('shows it whole before the board is measured', () => {
    expect(at({ slideWidth: 0, translateX: -40 })).toEqual({ opacity: 1, follows: true });
  });
});

function makePager(): SwipePager {
  const value = <Value>(initial: Value) => ({ value: initial });
  return {
    translateX: value(0),
    slideWidth: value(WIDTH),
    flingDirection: value(0),
    uiSteps: value(0),
    jsState: value<SwipePagerJsState>({ center: 0, hasPrevious: true, hasNext: true, processedStep: 0 }),
  } as unknown as SwipePager;
}

describe('useSwipeStaleContentStyle', () => {
  beforeEach(() => {
    reactions.length = 0;
    timings.length = 0;
  });

  it('follows the drag frame by frame, hides through the step and fades back once it renders', () => {
    const pager = makePager();
    const { result } = renderHook(() => useSwipeStaleContentStyle(pager));
    const style = result.current as unknown as () => { opacity: number };
    const reaction = reactions[reactions.length - 1];
    let before: unknown = null;
    const frame = () => {
      const now = reaction.prepare();
      reaction.react(now as never, before as never);
      before = now;
    };

    frame();
    expect(style().opacity).toBe(1);

    // The drag: followed directly, no fade.
    pager.translateX.value = -120;
    frame();
    expect(style().opacity).toBeCloseTo(0.25, 6);
    expect(timings).toHaveLength(0);

    // Released past the threshold: the fling carries the fade on to 0.
    pager.uiSteps.value = 1;
    pager.flingDirection.value = 1;
    for (const offset of [-200, -280, -319]) {
      pager.translateX.value = offset;
      frame();
    }
    expect(style().opacity).toBe(0);

    // Landed before the JS thread rendered the step: still hidden, though the
    // offset is back to 0.
    pager.flingDirection.value = 0;
    pager.translateX.value = 0;
    frame();
    expect(style().opacity).toBe(0);

    // Rendered: one fade back in, already about the new climb.
    pager.jsState.value = { ...pager.jsState.value, center: 1, processedStep: 1 };
    frame();
    expect(timings).toEqual([{ toValue: 1, duration: 150 }]);
    expect(style().opacity).toBe(1);
  });

  // A re-run while that fade was under way used to set the opacity outright,
  // cancelling the fade: the lines popped to full strength.
  it('carries a fade on through a re-run, to where the board now puts it, in the time it had left', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const pager = makePager();
    renderHook(() => useSwipeStaleContentStyle(pager));
    const reaction = reactions[reactions.length - 1];
    let before: unknown = null;
    const frame = () => {
      const now = reaction.prepare();
      reaction.react(now as never, before as never);
      before = now;
    };
    frame();
    // A step that landed before the JS thread rendered it, then rendered.
    pager.uiSteps.value = 1;
    frame();
    pager.jsState.value = { ...pager.jsState.value, processedStep: 1 };
    frame();
    expect(timings).toEqual([
      { toValue: 0, duration: 150 },
      { toValue: 1, duration: 150 },
    ]);

    // 60 ms in, the next drag begins.
    clock.mockReturnValue(1060);
    pager.translateX.value = -8;
    frame();
    expect(timings.at(-1)).toEqual({ toValue: 0.95, duration: 90 });

    // Once the fade is over, the drag is followed frame by frame again.
    clock.mockReturnValue(1200);
    pager.translateX.value = -16;
    frame();
    expect(timings).toHaveLength(3);
    clock.mockRestore();
  });
});
