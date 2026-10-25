// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { StrictMode, createElement, useEffect, type ReactNode } from 'react';
import type { Climb } from '@boardsesh/shared-schema';
import {
  useWorkoutOutcomeHold,
  type WorkoutOutcomeHoldInput,
  type WorkoutOutcomeShown,
} from '../use-workout-outcome-hold';
import { WALL_MOVED_GRACE_MS, type WorkoutOutcomeTarget } from '../workout-outcome';

// The player keeps Fell / Sent a moment after the wall leaves a timed block
// (#6231): an on-the-minute beat onto a climb outside it must not put the angle
// button or the heart under a finger already on its way to Fell.

const START_MS = 1_760_000_000_000;
const SESSION_ID = 'session-1';
const LIMIT_ITEM = 'item-1';
const COOL_DOWN_ITEM = 'item-2';

function target(queueItemUuid: string, overrides: Partial<WorkoutOutcomeTarget> = {}): WorkoutOutcomeTarget {
  return {
    climb: { uuid: `climb-${queueItemUuid}`, name: queueItemUuid } as unknown as Climb,
    queueItemUuid,
    sessionId: SESSION_ID,
    boardName: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,20',
    angle: 40,
    isMirror: false,
    ...overrides,
  };
}

const LIMIT_TARGET = target(LIMIT_ITEM);

/** The last timed climb on the wall, with its row up. */
const onTheLimitClimb: WorkoutOutcomeHoldInput = {
  live: LIMIT_TARGET,
  committedQueueItemUuid: LIMIT_ITEM,
  displayedQueueItemUuid: LIMIT_ITEM,
  sessionId: SESSION_ID,
  canLog: true,
};

/** The beat moved the wall to a climb outside the block, and the player followed it. */
const afterTheBeat: WorkoutOutcomeHoldInput = {
  ...onTheLimitClimb,
  live: null,
  committedQueueItemUuid: COOL_DOWN_ITEM,
  displayedQueueItemUuid: COOL_DOWN_ITEM,
};

const strictMode = ({ children }: { children: ReactNode }) => createElement(StrictMode, null, children);

/** Every row the player committed, in order, so a frame without one would show. */
function renderHold(initial: WorkoutOutcomeHoldInput = onTheLimitClimb, options: { strict?: boolean } = {}) {
  const committed: (WorkoutOutcomeShown | null)[] = [];
  const renders = { count: 0 };
  const rendered = renderHook(
    (input: WorkoutOutcomeHoldInput) => {
      renders.count += 1;
      const shown = useWorkoutOutcomeHold(input);
      useEffect(() => {
        committed.push(shown);
      });
      return shown;
    },
    { initialProps: initial, ...(options.strict ? { wrapper: strictMode } : {}) },
  );
  return { ...rendered, committed, renders };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START_MS);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useWorkoutOutcomeHold', () => {
  it('shows the live row for the climb on the wall, not held', () => {
    const { result } = renderHold();

    expect(result.current).toEqual({ target: LIMIT_TARGET, wallLeftAtMs: null });
  });

  it('holds the row for the climb the wall left, from the beat’s own frame', () => {
    const { result, rerender, committed } = renderHold();

    rerender(afterTheBeat);

    expect(result.current).toEqual({ target: LIMIT_TARGET, wallLeftAtMs: START_MS });
    // Never a frame without the row: that frame is where the angle button lands
    // under the finger.
    expect(committed.every((shown) => shown?.target === LIMIT_TARGET)).toBe(true);
  });

  it('starts one hold under Strict Mode’s double render, with no render loop', () => {
    const { result, rerender, committed, renders } = renderHold(onTheLimitClimb, { strict: true });
    const rendersBefore = renders.count;

    rerender(afterTheBeat);
    const held = result.current;

    // Strict Mode runs each render (and each state updater) twice: the beat costs
    // a handful of renders, never a loop, and leaves one hold.
    expect(renders.count - rendersBefore).toBeLessThanOrEqual(4);
    expect(held).toEqual({ target: LIMIT_TARGET, wallLeftAtMs: START_MS });
    expect(committed.every((shown) => shown?.target === LIMIT_TARGET)).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    rerender({ ...afterTheBeat });
    expect(result.current?.wallLeftAtMs).toBe(START_MS);

    act(() => {
      vi.advanceTimersByTime(WALL_MOVED_GRACE_MS - 1000);
    });
    expect(result.current).toBeNull();
  });

  it('swaps once the grace runs out, and stays swapped', () => {
    const { result, rerender } = renderHold();
    rerender(afterTheBeat);

    act(() => {
      vi.advanceTimersByTime(WALL_MOVED_GRACE_MS - 1);
    });
    expect(result.current?.target).toBe(LIMIT_TARGET);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBeNull();

    rerender({ ...afterTheBeat });
    act(() => {
      vi.advanceTimersByTime(WALL_MOVED_GRACE_MS);
    });
    expect(result.current).toBeNull();
  });

  it('keeps one hold across the player’s re-renders, so the grace is not restarted', () => {
    const { result, rerender } = renderHold();
    rerender(afterTheBeat);

    act(() => {
      vi.advanceTimersByTime(1500);
    });
    rerender({ ...afterTheBeat });

    expect(result.current?.wallLeftAtMs).toBe(START_MS);
    act(() => {
      vi.advanceTimersByTime(WALL_MOVED_GRACE_MS - 1500);
    });
    expect(result.current).toBeNull();
  });

  it('lets the row go at once when the climber swipes to browse', () => {
    const { result, rerender } = renderHold();

    // A preview: the wall did not move.
    rerender({ ...onTheLimitClimb, live: null, displayedQueueItemUuid: COOL_DOWN_ITEM });

    expect(result.current).toBeNull();
  });

  it('ends a hold at once when the climber swipes to browse during it', () => {
    const { result, rerender } = renderHold();
    rerender(afterTheBeat);

    rerender({ ...afterTheBeat, displayedQueueItemUuid: 'item-3' });

    expect(result.current).toBeNull();
  });

  it('gives way to the live row when the wall lands on another timed climb', () => {
    const nextLimit = target('item-3');
    const { result, rerender } = renderHold();
    rerender(afterTheBeat);

    rerender({ ...afterTheBeat, live: nextLimit, committedQueueItemUuid: 'item-3', displayedQueueItemUuid: 'item-3' });

    expect(result.current).toEqual({ target: nextLimit, wallLeftAtMs: null });
  });

  it('holds nothing for a climber who can no longer log here', () => {
    const { result, rerender } = renderHold();

    rerender({ ...afterTheBeat, canLog: false });

    expect(result.current).toBeNull();
  });

  it('ends a hold when the switch-board gate comes up or the climber signs out', () => {
    const { result, rerender } = renderHold();
    rerender(afterTheBeat);

    rerender({ ...afterTheBeat, canLog: false });

    expect(result.current).toBeNull();
  });

  it('holds nothing once the session is gone', () => {
    const { result, rerender } = renderHold();

    rerender({ ...afterTheBeat, sessionId: null });

    expect(result.current).toBeNull();
  });
});
