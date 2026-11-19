// @vitest-environment jsdom
//
// The player board's swap look, end to end in JS: the stationary carousel picks
// its transition, the wall swap steps it on the (stand-in) UI thread, and
// GpuClimbOverlay hands each frame to the native view as the `swapFrame`
// command. With the look on, a supporting binary gets the look and seven-number
// frames. Everywhere else (kill switch, Reduce Motion, older binaries) the
// native view must get exactly what it got before the look existed: the frames
// of the carousel with the shipped transition, and no look. Supporting binaries
// receive an explicit null to clear a look that was already mounted.
import { act, cleanup, render } from '@testing-library/react';
import { createElement, useRef, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SWIPE_THRESHOLD } from '@boardsesh/play-view';
import type { SharedValue } from 'react-native-reanimated';
import type { BoardArtReadiness } from '../../../lib/board-render/ready-board-art';
import type { BoardTransition } from '../board-transition';
import type { BoardSwapFrame } from '../swap-look';
import type { SwipePager } from '../use-swipe-pager';

/**
 * A small stand-in for Reanimated's UI runtime, as in use-wall-swap.test.tsx:
 * shared values, reactions that re-run when a value they read changes (and are
 * set up again when their dependencies change), and linear `withTiming` clocks
 * advanced by hand.
 */
const runtime = vi.hoisted(() => {
  type Shared = { value: unknown };
  type Reaction = { run: () => void; reads: Set<Shared>; dirty: boolean };
  type Clock = { shared: Shared; from: number; to: number; duration: number; elapsed: number };
  const reactions: Reaction[] = [];
  const clocks: Clock[] = [];
  let tracking: Set<Shared> | null = null;
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
  function register<Prepared>(
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
  function unregister(reaction: Reaction) {
    const index = reactions.indexOf(reaction);
    if (index >= 0) reactions.splice(index, 1);
  }
  return {
    makeShared,
    frame,
    advance,
    register,
    unregister,
    reset() {
      reactions.length = 0;
      clocks.length = 0;
    },
  };
});

const controls = vi.hoisted(() => ({
  apiVersion: 7,
  swapCommandApi: 1,
  swapLookVersion: 2,
  killed: false,
  reduceMotion: false,
  differentiateWithoutColor: 'off' as 'on' | 'off' | 'unknown',
  platform: 'ios' as 'ios' | 'android',
  /** Every `swapFrame` command the native view received, in order. */
  commands: [] as number[][],
  /** The native view's last props. */
  native: null as null | { swapLook?: readonly number[] | null; revealMode?: string },
}));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return controls.platform;
    },
  },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: <Styles,>(styles: Styles) => styles, absoluteFill: {} },
}));
vi.mock('react-native-reanimated', async () => {
  const { View } = await import('react-native');
  const sameDependencies = (left: readonly unknown[] | undefined, right: readonly unknown[] | undefined) =>
    left !== undefined &&
    right !== undefined &&
    left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]));
  return {
    default: { View, createAnimatedComponent: <Component,>(component: Component) => component },
    Easing: { linear: (value: number) => value },
    ReduceMotion: { Never: 'never', System: 'system' },
    withTiming: (to: number, config: { duration: number }) => ({ timingTo: to, duration: config.duration }),
    runOnUI:
      <Args extends unknown[]>(worklet: (...args: Args) => void) =>
      (...args: Args) =>
        worklet(...args),
    useSharedValue: <Value,>(initial: Value) => {
      const shared = useRef<{ value: Value } | null>(null);
      shared.current ??= runtime.makeShared(initial);
      return shared.current;
    },
    useDerivedValue: <Value,>(factory: () => Value) => ({
      get value() {
        return factory();
      },
    }),
    useAnimatedRef: () => useRef({ commandTarget: true }).current,
    useAnimatedProps: () => ({}),
    useAnimatedReaction: (
      prepare: () => unknown,
      react: (prepared: unknown, previous: unknown) => void,
      dependencies?: readonly unknown[],
    ) => {
      const registered = useRef<{ dependencies?: readonly unknown[]; reaction: ReturnType<typeof runtime.register> }>(
        null,
      );
      if (registered.current && sameDependencies(registered.current.dependencies, dependencies)) return;
      if (registered.current) runtime.unregister(registered.current.reaction);
      registered.current = { dependencies, reaction: runtime.register(prepare, react) };
    },
    dispatchCommand: (_target: unknown, name: string, args: readonly number[]) => {
      if (name === 'swapFrame') controls.commands.push([...args]);
    },
  };
});
vi.mock('../../../lib/board-render/gpu-native-capability', () => ({
  get climbOverlayGpuApiVersion() {
    return controls.apiVersion;
  },
  get climbOverlaySwapCommandApi() {
    return controls.swapCommandApi;
  },
  get climbOverlaySwapLookVersion() {
    return controls.swapLookVersion;
  },
  climbOverlaySwapLookProbe: null,
}));
vi.mock('../../../hooks/use-reduce-motion', () => ({ useReduceMotion: () => controls.reduceMotion }));
vi.mock('../../../hooks/use-differentiate-without-color', () => ({
  useDifferentiateWithoutColor: () => controls.differentiateWithoutColor,
}));
vi.mock('../../../providers/feature-flags-provider', () => ({
  usePlayerSwapLookEnabled: () => !controls.killed,
}));
vi.mock('../../../lib/app-visibility', () => ({ useIsAppActive: () => true, isAppActiveNow: () => true }));
vi.mock('../../../lib/board-render/gpu-telemetry', () => ({
  classifyGpuFallback: () => 'unknown',
  reportGpuFallback: () => {},
  reportGpuPreparation: () => {},
  resolveGpuFailureScope: () => 'frame',
}));
vi.mock('../../../../modules/climb-overlay-gpu/src', () => {
  const NativeView = (props: { swapLook?: readonly number[] | null; revealMode?: string }) => {
    controls.native = props;
    return null;
  };
  return { NativeMotionClimbOverlayGPU: NativeView, NativeFrameClimbOverlayGPU: NativeView };
});
// The board itself: the real GPU overlay, handed the carousel's transition as BoardImageNative would.
vi.mock('../../BoardImageNative', async () => {
  const { GpuClimbOverlay } = await import('../../GpuClimbOverlay');
  return {
    BoardImageNative: ({ gpuTransition }: { gpuTransition: Parameters<typeof GpuClimbOverlay>[0]['transition'] }) =>
      createElement(GpuClimbOverlay, {
        configJson: '{}',
        frames: 'p1r12',
        requestId: 'request',
        transition: gpuTransition,
        onPresented: () => {},
        onFailure: () => {},
        onReset: () => {},
        onRelease: () => {},
      }),
  };
});

const { StationaryBoardCarousel } = await import('../StationaryBoardCarousel');
const { PLAYER_SWAP_LOOK } = await import('../player-swap-look');
const { encodeSwapLook } = await import('../swap-look');
const { swapLookTransition } = await import('../swap-look-driver');

function makePager() {
  return {
    anchorPage: runtime.makeShared(0),
    translateX: runtime.makeShared(0),
    flingDirection: runtime.makeShared(0),
    uiSteps: runtime.makeShared(0),
    resetGeneration: runtime.makeShared(0),
    slideWidth: runtime.makeShared(390),
  } as unknown as SwipePager;
}

function mountCarousel(transition?: BoardTransition, swapFrameMirror?: SharedValue<BoardSwapFrame | null>) {
  const pager = makePager();
  const pageArt = runtime.makeShared<Readonly<Record<number, BoardArtReadiness>>>({});
  const element = (next?: BoardTransition) =>
    createElement(StationaryBoardCarousel, {
      boardProps: { frames: 'p1r12', boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20' } as Parameters<
        typeof StationaryBoardCarousel
      >[0]['boardProps'],
      previousFrames: 'p2r12',
      nextFrames: 'p3r12',
      centerPage: 0,
      pager,
      pageArt: pageArt as unknown as SharedValue<Readonly<Record<number, BoardArtReadiness>>>,
      boardBox: {},
      zoomStyle: {},
      onUnavailable: () => {},
      transition: next,
      swapFrameMirror,
    });
  const view = render(element(transition));
  return { pager, rerender: (next?: BoardTransition) => view.rerender(element(next)) };
}

/** A slow drag to the commit distance. */
function drag(pager: SwipePager) {
  for (const fraction of [0.25, 0.5, 0.75, 1]) {
    pager.translateX.value = -SWIPE_THRESHOLD * fraction;
    runtime.frame();
  }
}

/** A slow drag to the commit distance, a release, the fling landing, then the swap to its end. */
function swipe(pager: SwipePager) {
  drag(pager);
  pager.uiSteps.value += 1;
  pager.flingDirection.value = 1;
  runtime.frame();
  for (let elapsed = 0; elapsed < 96; elapsed += 16) runtime.advance(16);
  pager.anchorPage.value += 1;
  pager.flingDirection.value = 0;
  pager.translateX.value = 0;
  runtime.frame();
  for (let elapsed = 96; elapsed < 600; elapsed += 16) runtime.advance(16);
}

/** The look the native view holds now (read through a call, so nothing narrows it). */
function nativeSwapLook() {
  return controls.native?.swapLook;
}

/** What the native view gets for one swipe, from a fresh mount. */
function sent(transition?: BoardTransition) {
  runtime.reset();
  controls.commands = [];
  controls.native = null;
  const { pager } = mountCarousel(transition);
  swipe(pager);
  const result = { commands: controls.commands, swapLook: nativeSwapLook() };
  cleanup();
  return result;
}

/**
 * The frames without their sequence numbers and without a frame that repeats
 * the one before it. A swipe's clocks restart from wherever the previous swipe
 * left them (the look's swap clock runs at least 400 ms, the shipped one 200),
 * which can step the same weights twice; the native view draws nothing new.
 */
function weightsShown(commands: readonly number[][]): number[][] {
  const shown: number[][] = [];
  for (const command of commands) {
    const weights = command.slice(0, 4);
    const last = shown.at(-1);
    if (!last || weights.some((value, index) => value !== last[index])) shown.push(weights);
  }
  return shown;
}

/** The carousel exactly as it ran before the look: the shipped swap, asked for outright. */
const SHIPPED: BoardTransition = { revealMode: 'swap' };

beforeEach(() => {
  controls.apiVersion = 7;
  controls.swapCommandApi = 1;
  controls.swapLookVersion = 2;
  controls.killed = false;
  controls.reduceMotion = false;
  controls.differentiateWithoutColor = 'off';
  controls.platform = 'ios';
});
afterEach(() => cleanup());

describe('the player board’s swap look', () => {
  it('on a binary with the look, sends the player’s look and seven-number frames', () => {
    const { commands, swapLook } = sent();
    expect(controls.native?.revealMode).toBe('swap');
    const look = swapLookTransition(PLAYER_SWAP_LOOK).look;
    if (!look) throw new Error('no look');
    expect(swapLook).toEqual(encodeSwapLook(look));
    expect(commands.length).toBeGreaterThan(20);
    for (const command of commands) {
      expect(command).toHaveLength(7);
      for (const number of command) expect(Number.isFinite(number)).toBe(true);
    }
    // The ghost: the next climb lights while the finger is still down.
    expect(commands.some(([, outgoing, incoming]) => outgoing < 1 && incoming > 0)).toBe(true);
    // And it ends at rest on the next climb.
    expect(commands.at(-1)?.slice(0, 3)).toEqual([1, 1, 0]);
    // Not the shipped swap's frames.
    expect(commands.map((command) => command.slice(0, 4))).not.toEqual(
      sent(SHIPPED).commands.map((command) => command.slice(0, 4)),
    );
  });

  it.each([
    ['the kill switch is on', () => (controls.killed = true)],
    ['Reduce Motion is on', () => (controls.reduceMotion = true)],
    ['Differentiate Without Color is on', () => (controls.differentiateWithoutColor = 'on')],
    ['the binary has no swap look (swapLookVersion 0)', () => (controls.swapLookVersion = 0)],
    ['the binary is an older iOS one (swapLookVersion 1)', () => (controls.swapLookVersion = 1)],
    ['the binary has no swap command', () => (controls.swapCommandApi = 0)],
  ])('when %s, sends exactly the shipped frames and no look', (_case, arrange) => {
    arrange();
    const player = sent();
    const shipped = sent(SHIPPED);
    if (controls.swapLookVersion >= 2) expect(player.swapLook).toBeNull();
    else expect(player.swapLook).toBeUndefined();
    expect(player.commands).toEqual(shipped.commands);
    for (const command of player.commands) expect(command).toHaveLength(5);
  });

  it('on iOS holds the look until Differentiate Without Color reads off', () => {
    controls.differentiateWithoutColor = 'unknown';
    const player = sent();
    expect(player.swapLook).toBeNull();
    expect(player.commands).toEqual(sent(SHIPPED).commands);
  });

  it('on Android, which has no Differentiate Without Color setting, an unknown read keeps the look', () => {
    controls.platform = 'android';
    controls.differentiateWithoutColor = 'unknown';
    expect(sent().swapLook).toBeDefined();
  });

  it('under Reduce Motion the frames are the shipped dissolve: no dim while dragging, shared holds whole', () => {
    controls.reduceMotion = true;
    runtime.reset();
    controls.commands = [];
    const { pager } = mountCarousel();
    drag(pager);
    expect(controls.commands.length).toBeGreaterThan(3);
    for (const [, outgoing, incoming] of controls.commands) expect([outgoing, incoming]).toEqual([1, 0]);
    swipe(pager);
    for (const [, , , shared] of controls.commands) expect(shared).toBe(1);
    expect(controls.commands.at(-1)?.slice(0, 4)).toEqual([1, 1, 0, 1]);
  });

  it('Reduce Motion turning off on an open board brings the look in from rest, never a stale state', () => {
    // useReduceMotion reads true until the system answers, so every launch starts here.
    controls.reduceMotion = true;
    runtime.reset();
    controls.commands = [];
    const { pager, rerender } = mountCarousel();
    swipe(pager);
    expect(controls.native?.swapLook).toBeNull();
    controls.reduceMotion = false;
    act(() => rerender());
    expect(controls.native?.swapLook).toBeDefined();
    controls.commands = [];
    swipe(pager);
    expect(controls.commands.length).toBeGreaterThan(20);
    for (const command of controls.commands) {
      expect(command).toHaveLength(7);
      for (const number of command) expect(Number.isFinite(number)).toBe(true);
    }
    // The pair and weights, then (after the sequence) both climbs' arrival codes: at rest, leaving.
    const last = controls.commands.at(-1) ?? [];
    expect([...last.slice(0, 4), ...last.slice(5)]).toEqual([2, 1, 0, 1, 0, 0]);
  });

  it('the kill switch takes effect on an open board, and the next swipe is the shipped swap', () => {
    runtime.reset();
    controls.commands = [];
    const { pager, rerender } = mountCarousel();
    swipe(pager);
    expect(controls.native?.swapLook).toBeDefined();
    controls.killed = true;
    act(() => rerender());
    expect(controls.native?.swapLook).toBeNull();
    controls.commands = [];
    swipe(pager);
    const afterKill = controls.commands;
    cleanup();
    // The second swipe on a board that never had the look.
    runtime.reset();
    controls.commands = [];
    const shipped = mountCarousel(SHIPPED);
    swipe(shipped.pager);
    controls.commands = [];
    swipe(shipped.pager);
    expect(weightsShown(afterKill)).toEqual(weightsShown(controls.commands));
    for (const command of afterKill) expect(command).toHaveLength(5);
  });
});

describe('the frost mirror (option I)', () => {
  /** A mirror that records every value written to it. */
  function recordingMirror() {
    const written: (BoardSwapFrame | null)[] = [];
    const mirror = {
      get value() {
        return written.at(-1) ?? null;
      },
      set value(next: BoardSwapFrame | null) {
        written.push(next);
      },
    };
    return { mirror: mirror as unknown as SharedValue<BoardSwapFrame | null>, written };
  }

  it('copies every frame the board draws, look codes included, for the wall button', () => {
    runtime.reset();
    controls.commands = [];
    const { mirror, written } = recordingMirror();
    const { pager } = mountCarousel(undefined, mirror);
    swipe(pager);
    // The board's own commands, without their sequence: the same frames, in order.
    const boardFrames = controls.commands.map(([position, outgoing, incoming, shared, , out, into]) => [
      position,
      outgoing,
      incoming,
      shared,
      out,
      into,
    ]);
    expect(written.slice(-boardFrames.length)).toEqual(boardFrames);
    cleanup();
    expect(written.at(-1)).toBeNull();
  });

  it('writes null on a board that only wipes, so the frost runs its own release', () => {
    runtime.reset();
    controls.apiVersion = 5;
    const { mirror, written } = recordingMirror();
    mountCarousel(undefined, mirror);
    expect(written).toEqual([null]);
  });
});
