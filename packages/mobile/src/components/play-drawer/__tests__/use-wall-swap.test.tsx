// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SWIPE_THRESHOLD } from '@boardsesh/play-view';
import type { SwipePager } from '../use-swipe-pager';
import type { BoardTransition, BoardTransitionDriver } from '../board-transition';

/**
 * A small stand-in for Reanimated's UI runtime: shared values, reactions that
 * re-run only when a value their `prepare` read has changed, and linear
 * `withTiming` clocks advanced by hand. A frame runs every dirty reaction until
 * none is left, as the mapper pass does once a gesture worklet has finished.
 */
const runtime = vi.hoisted(() => {
  type Shared = { value: unknown };
  type Reaction = { run: () => void; reads: Set<Shared>; dirty: boolean };
  type Clock = { shared: Shared; from: number; to: number; duration: number; elapsed: number };
  const reactions: Reaction[] = [];
  const clocks: Clock[] = [];
  let tracking: Set<Shared> | null = null;
  const timingConfigs: unknown[] = [];
  function markDirty(shared: Shared) {
    for (const reaction of reactions) if (reaction.reads.has(shared)) reaction.dirty = true;
  }
  function makeShared<Value>(initial: Value): { value: Value } {
    let contents: unknown = initial;
    const shared: Shared = {
      get value() {
        tracking?.add(shared);
        return contents;
      },
      set value(next: unknown) {
        const index = clocks.findIndex((clock) => clock.shared === shared);
        if (index >= 0) clocks.splice(index, 1);
        if (next && typeof next === 'object' && 'timingTo' in next) {
          const timing = next as { timingTo: number; duration: number };
          clocks.push({ shared, from: contents as number, to: timing.timingTo, duration: timing.duration, elapsed: 0 });
          return;
        }
        if (next === contents) return;
        contents = next;
        markDirty(shared);
      },
    };
    return shared as { value: Value };
  }
  function frame() {
    for (let pass = 0; pass < 50; pass++) {
      const dirty = reactions.filter((reaction) => reaction.dirty);
      if (dirty.length === 0) return;
      for (const reaction of dirty) {
        reaction.dirty = false;
        reaction.run();
      }
    }
    throw new Error('Reactions never settled');
  }
  function advance(ms: number) {
    const running = clocks.splice(0, clocks.length);
    for (const clock of running) {
      clock.elapsed += ms;
      const done = clock.elapsed >= clock.duration;
      clock.shared.value = done ? clock.to : clock.from + ((clock.to - clock.from) * clock.elapsed) / clock.duration;
      if (!done) clocks.push(clock);
    }
    frame();
  }
  function useAnimatedReaction<Prepared>(
    prepare: () => Prepared,
    react: (prepared: Prepared, previous: Prepared | null) => void,
  ): Reaction {
    const reaction: Reaction = { run: () => {}, reads: new Set(), dirty: false };
    let previous: Prepared | null = null;
    reaction.run = () => {
      tracking = new Set();
      const prepared = prepare();
      reaction.reads = tracking;
      tracking = null;
      react(prepared, previous);
      previous = prepared;
    };
    reactions.push(reaction);
    reaction.run();
    frame();
    return reaction;
  }
  /** A reaction whose dependencies changed: Reanimated drops the old one and starts the new. */
  function replaceReaction(old: Reaction) {
    const index = reactions.indexOf(old);
    if (index >= 0) reactions.splice(index, 1);
  }
  return {
    reactions,
    clocks,
    timingConfigs,
    makeShared,
    frame,
    advance,
    useAnimatedReaction,
    replaceReaction,
    reduceMotion: false,
    reset() {
      reactions.length = 0;
      clocks.length = 0;
      timingConfigs.length = 0;
    },
  };
});

vi.mock('react-native-reanimated', async () => {
  const { useRef } = await import('react');
  return {
    Easing: { linear: (value: number) => value },
    ReduceMotion: { Never: 'never', System: 'system' },
    withTiming: (to: number, config: { duration: number }) => {
      runtime.timingConfigs.push(config);
      return { timingTo: to, duration: config.duration };
    },
    useSharedValue: <Value,>(initial: Value) => {
      const shared = useRef<{ value: Value } | null>(null);
      shared.current ??= runtime.makeShared(initial);
      return shared.current;
    },
    useAnimatedReaction: (
      prepare: () => unknown,
      react: (prepared: unknown, previous: unknown) => void,
      dependencies?: unknown[],
    ) => {
      const registered = useRef<{ dependencies: unknown[] | undefined; reaction: unknown } | null>(null);
      const current = registered.current;
      const changed =
        current === null ||
        (dependencies !== undefined &&
          (current.dependencies === undefined ||
            dependencies.length !== current.dependencies.length ||
            dependencies.some((dependency, index) => !Object.is(dependency, current.dependencies?.[index]))));
      if (!changed) return;
      if (current !== null) runtime.replaceReaction(current.reaction as Parameters<typeof runtime.replaceReaction>[0]);
      registered.current = { dependencies, reaction: runtime.useAnimatedReaction(prepare, react) };
    },
  };
});
vi.mock('../../../hooks/use-reduce-motion', () => ({ useReduceMotion: () => runtime.reduceMotion }));

const { useWallSwap } = await import('../use-wall-swap');

function pager() {
  return {
    anchorPage: runtime.makeShared(0),
    translateX: runtime.makeShared(0),
    flingDirection: runtime.makeShared(0),
    uiSteps: runtime.makeShared(0),
    resetGeneration: runtime.makeShared(0),
  } as unknown as SwipePager;
}

function mount(enabled = true) {
  const swipe = pager();
  const { result } = renderHook(() => useWallSwap(swipe, 0, enabled));
  return { swipe, frame: () => [...result.current.value] };
}

beforeEach(() => {
  runtime.reset();
  runtime.reduceMotion = false;
});

describe('useWallSwap', () => {
  it('turns the pager into one frame: the pair, then the three weights', () => {
    const { swipe, frame } = mount();
    expect(frame()).toEqual([0, 1, 0, 1]);
    swipe.translateX.value = -SWIPE_THRESHOLD / 2;
    runtime.frame();
    // Shared holds dip with the outgoing ones while dragging.
    expect(frame()).toEqual([0.25, 0.7, 0, 0.7]);
    swipe.translateX.value = -SWIPE_THRESHOLD * 2;
    runtime.frame();
    expect(frame()).toEqual([0.25, 0.4, 0, 0.4]);
    swipe.translateX.value = SWIPE_THRESHOLD * 2;
    swipe.translateX.value = 0;
    runtime.frame();
    expect(frame()).toEqual([0, 1, 0, 1]);
  });

  it('runs a commit on its own clock until the arriving climb stands alone', () => {
    const { swipe, frame } = mount();
    swipe.translateX.value = -SWIPE_THRESHOLD;
    runtime.frame();
    // startFling: one worklet, so the reaction sees the step and the fling together.
    swipe.uiSteps.value = 1;
    swipe.flingDirection.value = 1;
    runtime.frame();
    expect(runtime.timingConfigs.at(-1)).toMatchObject({ duration: 200, reduceMotion: 'never' });
    const seen: number[][] = [frame()];
    for (let elapsed = 0; elapsed < 96; elapsed += 16) {
      runtime.advance(16);
      seen.push(frame());
    }
    // landFling
    swipe.anchorPage.value = 1;
    swipe.flingDirection.value = 0;
    swipe.translateX.value = 0;
    runtime.frame();
    for (let elapsed = 96; elapsed < 208; elapsed += 16) {
      runtime.advance(16);
      seen.push(frame());
    }
    expect(seen[0][1]).toBeCloseTo(0.4, 10);
    expect(seen.slice(0, -1).every(([position]) => position === 0.25)).toBe(true);
    expect(seen.at(-1)).toEqual([1, 1, 0, 1]);
    for (const [, outgoing, incoming] of seen) if (incoming > 0) expect(outgoing).toBeLessThanOrEqual(0.4);
    // Shared holds hold 40% until the incoming ones pass it, then follow them back.
    for (const [, outgoing, incoming, shared] of seen) expect(shared).toBe(Math.max(0.4, outgoing, incoming));
    expect(seen.some(([, , incoming, shared]) => incoming > 0.4 && incoming < 1 && shared === incoming)).toBe(true);
    expect(runtime.clocks).toHaveLength(0);
  });

  it('under Reduce Motion skips the dim, dissolves in 240 ms and keeps shared holds whole', () => {
    runtime.reduceMotion = true;
    const { swipe, frame } = mount();
    swipe.translateX.value = -SWIPE_THRESHOLD * 2;
    runtime.frame();
    expect(frame()).toEqual([0.25, 1, 0, 1]);
    swipe.uiSteps.value = 1;
    swipe.flingDirection.value = 1;
    runtime.frame();
    expect(runtime.timingConfigs.at(-1)).toMatchObject({ duration: 240, reduceMotion: 'never' });
    swipe.anchorPage.value = 1;
    swipe.flingDirection.value = 0;
    swipe.translateX.value = 0;
    const shared: number[] = [];
    for (let elapsed = 0; elapsed < 240; elapsed += 16) {
      runtime.advance(16);
      shared.push(frame()[3]);
    }
    expect(frame()).toEqual([1, 1, 0, 1]);
    expect(shared.every((weight) => weight === 1)).toBe(true);
  });

  // The PNG board's still wall turns it off and on again on a mounted board:
  // the GPU board taking over and handing back (playback, a GPU failure), or
  // `png-wall-fade-kill` flipped live. Steps taken meanwhile are not commits.
  it('starts from rest on the current page when switched back on', () => {
    const swipe = pager();
    const { result, rerender } = renderHook(({ enabled }) => useWallSwap(swipe, 0, enabled), {
      initialProps: { enabled: true },
    });
    const frame = () => [...result.current.value];
    swipe.translateX.value = -SWIPE_THRESHOLD;
    runtime.frame();
    swipe.uiSteps.value = 1;
    swipe.flingDirection.value = 1;
    runtime.frame();
    swipe.anchorPage.value = 1;
    swipe.flingDirection.value = 0;
    swipe.translateX.value = 0;
    runtime.advance(400);
    expect(frame()).toEqual([1, 1, 0, 1]);

    rerender({ enabled: false });
    // A swipe on the other board, which this one did not see. The frame rests
    // on the pager's page meanwhile, so nothing reads a page it has left.
    swipe.uiSteps.value = 2;
    swipe.anchorPage.value = 2;
    runtime.frame();
    expect(frame()).toEqual([2, 1, 0, 1]);
    const clocksStarted = runtime.timingConfigs.length;

    rerender({ enabled: true });
    expect(frame()).toEqual([2, 1, 0, 1]);
    expect(runtime.timingConfigs).toHaveLength(clocksStarted);
  });

  it('stays at rest for the wipe', () => {
    const { swipe, frame } = mount(false);
    swipe.translateX.value = -SWIPE_THRESHOLD;
    swipe.uiSteps.value = 1;
    swipe.flingDirection.value = 1;
    runtime.frame();
    expect(frame()).toEqual([0, 1, 0, 1]);
    swipe.anchorPage.value = 1;
    runtime.frame();
    expect(frame()).toEqual([1, 1, 0, 1]);
    expect(runtime.clocks).toHaveLength(0);
  });
});

describe('useWallSwap with a transition', () => {
  function mountWith(transition: BoardTransition) {
    const swipe = pager();
    const { result } = renderHook(() => useWallSwap(swipe, 0, true, transition));
    return { swipe, frame: () => [...result.current.value] };
  }

  it('slows the clocks in real time while they count the same swap', () => {
    const { swipe, frame } = mountWith({ revealMode: 'swap', slowdown: 4 });
    swipe.translateX.value = -SWIPE_THRESHOLD;
    runtime.frame();
    swipe.uiSteps.value = 1;
    swipe.flingDirection.value = 1;
    runtime.frame();
    // 200 clock milliseconds over 800 real ones.
    expect(runtime.timingConfigs.at(-1)).toMatchObject({ duration: 800, reduceMotion: 'never' });
    swipe.anchorPage.value = 1;
    swipe.flingDirection.value = 0;
    swipe.translateX.value = 0;
    runtime.frame();
    runtime.advance(400);
    // Half way in real time is half way through the swap: still a pair on screen.
    expect(frame()[0]).toBe(0.25);
    runtime.advance(400);
    expect(frame()).toEqual([1, 1, 0, 1]);
  });

  it('takes Reduce Motion from the transition over the system setting', () => {
    const { swipe, frame } = mountWith({ revealMode: 'swap', reduceMotion: true });
    swipe.translateX.value = -SWIPE_THRESHOLD * 2;
    runtime.frame();
    expect(frame()).toEqual([0.25, 1, 0, 1]);
  });

  it('runs the driver it is given, and starts the clocks it asks for', () => {
    const steps: number[] = [];
    const driver: BoardTransitionDriver = {
      rest: (input) => ({ page: input.anchor }),
      step: (_previous, input) => {
        steps.push(input.offset);
        return {
          state: { page: input.anchor },
          frame: [input.anchor, 0.5, 0.5, 0.5],
          startSwapMs: input.offset === -10 ? 300 : null,
          startSettleMs: null,
        };
      },
    };
    const { swipe, frame } = mountWith({ revealMode: 'swap', driver, slowdown: 2 });
    swipe.translateX.value = -10;
    runtime.frame();
    expect(frame()).toEqual([0, 0.5, 0.5, 0.5]);
    expect(steps).toContain(-10);
    expect(runtime.timingConfigs.at(-1)).toMatchObject({ duration: 600 });
  });
});
