// @vitest-environment jsdom
// The wall button's swipe left to drive (#7113): when letting go commits, what
// a refusal or a failed drive does, the threshold buzz, and that a pan
// swallows the tap it ended in. The pan's callbacks are driven by hand, the way
// use-full-swipe's test does; worklets run on the JS thread here.
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type PanEvent = { translationX: number; velocityX: number; canceled?: boolean };
type PanConfig = {
  enabled: boolean;
  onBegin: () => void;
  onActivate: () => void;
  onUpdate: (event: PanEvent) => void;
  onDeactivate: (event: PanEvent & { canceled: boolean }) => void;
  onFinalize: () => void;
};

const native = vi.hoisted(() => ({
  config: null as PanConfig | null,
  /** An animation's end callbacks, run by hand: real ones fire after the value is set. */
  animationEnds: [] as ((finished: boolean) => void)[],
}));
vi.mock('react-native-gesture-handler', () => ({
  usePanGesture: (config: PanConfig) => {
    native.config = config;
    return { config };
  },
}));
// Animations land on their target at once; a spring or a timing is just its value.
vi.mock('react-native-reanimated', async () => {
  const { useRef } = await import('react');
  return {
    runOnJS:
      (callback: (...args: unknown[]) => unknown) =>
      (...args: unknown[]) =>
        callback(...args),
    useSharedValue: <T,>(value: T) => useRef({ value }).current,
    cancelAnimation: vi.fn(),
    withSpring: (to: number, _config?: unknown, done?: (finished: boolean) => void) => {
      if (done) native.animationEnds.push(done);
      return to;
    },
    withTiming: (to: number, _config?: unknown, done?: (finished: boolean) => void) => {
      if (done) native.animationEnds.push(done);
      return to;
    },
    withDelay: (_ms: number, value: number) => value,
    withSequence: (...values: number[]) => values.at(-1),
  };
});
const haptics = vi.hoisted(() => ({ hapticMedium: vi.fn(), hapticError: vi.fn() }));
vi.mock('../../../lib/haptics', () => haptics);
const hint = vi.hoisted(() => ({ markWallSwipeUsed: vi.fn(async () => {}), recordWallSwipePeekPlayed: vi.fn() }));
vi.mock('../../../lib/wall-swipe-hint', () => hint);

import { SWIPE_ARM_GRACE_MS, SWIPE_LIVE_GRACE_MS, useWallSwipe, type UseWallSwipeOptions } from '../use-wall-swipe';

const WIDTH = 343;

function setup(overrides: Partial<UseWallSwipeOptions> = {}) {
  const onSwipe = vi.fn(() => 'started' as const);
  const onCancel = vi.fn();
  const initial: UseWallSwipeOptions = {
    enabled: true,
    driving: false,
    drivePhase: 'off',
    onSwipe,
    onCancel,
    peekToken: 0,
    reduceMotion: false,
    width: WIDTH,
    ...overrides,
  };
  const hook = renderHook((props: UseWallSwipeOptions) => useWallSwipe(props), { initialProps: initial });
  return { hook, onSwipe: initial.onSwipe ?? onSwipe, onCancel, initial };
}

/** One drag: touch, activate past 10 pt, move, let go. */
function drag(translationX: number, velocityX = 0, { canceled = false } = {}) {
  const pan = native.config;
  if (!pan) throw new Error('no pan');
  act(() => {
    pan.onBegin();
    pan.onActivate();
    pan.onUpdate({ translationX, velocityX });
    pan.onDeactivate({ translationX, velocityX, canceled });
    pan.onFinalize();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  native.config = null;
  native.animationEnds = [];
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('useWallSwipe', () => {
  it('claims a leftward drag past 10 pt and gives way to a vertical one past 14 pt', () => {
    setup();
    expect(native.config).toMatchObject({ enabled: true, activeOffsetX: -10, failOffsetY: [-14, 14] });
  });

  it('commits past 55% of the width, holds the frost, and buzzes once at the threshold', () => {
    const { hook, onSwipe, onCancel } = setup();
    drag(-0.6 * WIDTH);
    expect(onSwipe).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
    expect(haptics.hapticMedium).toHaveBeenCalledOnce();
    expect(hook.result.current.committed).toBe(true);
    expect(hook.result.current.progress.value).toBe(1);
    expect(hint.markWallSwipeUsed).toHaveBeenCalledOnce();
    // While committed the pan is off: a second swipe can't start a second drive.
    expect(native.config?.enabled).toBe(false);
  });

  it('springs back short of the commit point, and reports the cancel', () => {
    const { hook, onSwipe, onCancel } = setup();
    drag(-0.5 * WIDTH);
    expect(onSwipe).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledOnce();
    expect(haptics.hapticMedium).not.toHaveBeenCalled();
    expect(hook.result.current.progress.value).toBe(0);
    expect(hook.result.current.committed).toBe(false);
  });

  it('commits a fast fling once it is past a quarter, never before', () => {
    const fling = setup();
    drag(-0.3 * WIDTH, -900);
    expect(fling.onSwipe).toHaveBeenCalledOnce();
    fling.hook.unmount();

    const short = setup();
    drag(-0.2 * WIDTH, -1500);
    expect(short.onSwipe).not.toHaveBeenCalled();
    expect(short.onCancel).toHaveBeenCalledOnce();
    short.hook.unmount();

    const slow = setup();
    drag(-0.4 * WIDTH, -500);
    expect(slow.onSwipe).not.toHaveBeenCalled();
  });

  it('treats a cancelled pan as a cancel, however far it went', () => {
    const { onSwipe, onCancel } = setup();
    drag(-0.9 * WIDTH, 0, { canceled: true });
    expect(onSwipe).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('springs back with an error buzz when nothing starts (a crewmate’s board)', () => {
    const onSwipe = vi.fn(() => 'held_by_crew' as const);
    const { hook } = setup({ onSwipe });
    drag(-0.7 * WIDTH);
    expect(onSwipe).toHaveBeenCalledOnce();
    expect(haptics.hapticError).toHaveBeenCalledOnce();
    expect(hook.result.current.committed).toBe(false);
    expect(hook.result.current.progress.value).toBe(0);
    expect(hint.markWallSwipeUsed).not.toHaveBeenCalled();
  });

  it('lets the full frost take over once the model says driving', () => {
    const { hook, initial } = setup();
    drag(-0.8 * WIDTH);
    hook.rerender({ ...initial, enabled: false, drivePhase: 'arming' });
    expect(hook.result.current.committed).toBe(true);
    hook.rerender({ ...initial, enabled: false, driving: true });
    expect(hook.result.current.committed).toBe(false);
    expect(hook.result.current.progress.value).toBe(0);
    expect(haptics.hapticError).not.toHaveBeenCalled();
  });

  it('springs back with an error buzz when the drive ends before it went live (a failed connect)', () => {
    const { hook, initial } = setup();
    drag(-0.8 * WIDTH);
    hook.rerender({ ...initial, enabled: false, drivePhase: 'arming' });
    hook.rerender({ ...initial, enabled: true, drivePhase: 'off' });
    expect(hook.result.current.committed).toBe(false);
    expect(hook.result.current.progress.value).toBe(0);
    expect(haptics.hapticError).toHaveBeenCalledOnce();
  });

  it('treats a live drive as landed: no error buzz while the climb catches up', () => {
    const { hook, initial } = setup();
    drag(-0.8 * WIDTH);
    hook.rerender({ ...initial, enabled: false, drivePhase: 'arming' });
    // `markDriveLive` lands before the link's lit confirm.
    hook.rerender({ ...initial, enabled: false, drivePhase: 'live' });
    expect(hook.result.current.committed).toBe(true);
    act(() => {
      vi.advanceTimersByTime(SWIPE_LIVE_GRACE_MS);
    });
    expect(hook.result.current.committed).toBe(false);
    expect(haptics.hapticError).not.toHaveBeenCalled();
  });

  it('ignores a drag after a hold has fired in the same touch', () => {
    const { hook, onSwipe, onCancel } = setup();
    const pan = native.config;
    if (!pan) throw new Error('no pan');
    act(() => {
      pan.onBegin();
      hook.result.current.noteLongPress();
      pan.onActivate();
      pan.onUpdate({ translationX: -0.8 * WIDTH, velocityX: 0 });
      pan.onDeactivate({ translationX: -0.8 * WIDTH, velocityX: 0, canceled: false });
      pan.onFinalize();
    });
    expect(onSwipe).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(hook.result.current.progress.value).toBe(0);
    expect(hook.result.current.frostArmed).toBe(false);
    // The next touch swipes again.
    drag(-0.8 * WIDTH);
    expect(onSwipe).toHaveBeenCalledOnce();
  });

  it('gives up when the drive never arms', () => {
    const { hook } = setup();
    drag(-0.8 * WIDTH);
    expect(hook.result.current.committed).toBe(true);
    act(() => {
      vi.advanceTimersByTime(SWIPE_ARM_GRACE_MS);
    });
    expect(hook.result.current.committed).toBe(false);
    expect(haptics.hapticError).toHaveBeenCalledOnce();
  });

  it('swallows the tap a pan ended in, and lets the next one through', () => {
    const { hook } = setup();
    const pan = native.config;
    if (!pan) throw new Error('no pan');
    act(() => {
      pan.onBegin();
      pan.onActivate();
      pan.onUpdate({ translationX: -40, velocityX: 0 });
      pan.onDeactivate({ translationX: -40, velocityX: 0, canceled: false });
      pan.onFinalize();
    });
    // The Pressable's press lands in the same tick as the pan's end.
    expect(hook.result.current.consumePanned()).toBe(true);
    act(() => {
      vi.runAllTimers();
    });
    expect(hook.result.current.consumePanned()).toBe(false);
    // A plain tap: touched, never activated.
    act(() => {
      pan.onBegin();
      pan.onFinalize();
    });
    expect(hook.result.current.consumePanned()).toBe(false);
  });

  it('mounts the frost once a drag gets going, never on a plain tap, and unmounts it at rest', () => {
    const { hook } = setup();
    const pan = native.config;
    if (!pan) throw new Error('no pan');
    act(() => {
      pan.onBegin();
      pan.onFinalize();
    });
    expect(hook.result.current.frostArmed).toBe(false);
    drag(-0.3 * WIDTH);
    expect(hook.result.current.frostArmed).toBe(true);
    // The spring back lands: the frost goes.
    act(() => native.animationEnds.forEach((end) => end(true)));
    expect(hook.result.current.frostArmed).toBe(false);
  });

  it('says when letting go would commit', () => {
    const { hook } = setup();
    const pan = native.config;
    if (!pan) throw new Error('no pan');
    act(() => {
      pan.onBegin();
      pan.onActivate();
      pan.onUpdate({ translationX: -0.6 * WIDTH, velocityX: 0 });
    });
    expect(hook.result.current.releaseArmed).toBe(true);
    // Each frame past the point is no new crossing: one buzz only.
    act(() => pan.onUpdate({ translationX: -0.7 * WIDTH, velocityX: 0 }));
    expect(haptics.hapticMedium).toHaveBeenCalledOnce();
    act(() => pan.onUpdate({ translationX: -0.3 * WIDTH, velocityX: 0 }));
    expect(hook.result.current.releaseArmed).toBe(false);
  });

  it('plays the peek once per token, as a fade under Reduce Motion', () => {
    const { hook, initial } = setup({ reduceMotion: true });
    hook.rerender({ ...initial, reduceMotion: true, peekToken: 1 });
    expect(hook.result.current.frostArmed).toBe(true);
    // The strip stands still at 28 pt while it fades: no slide.
    expect(hook.result.current.progress.value).toBeCloseTo(28 / WIDTH);
    expect(native.animationEnds).toHaveLength(1);
    // The fade's end puts the strip away again.
    act(() => native.animationEnds.forEach((end) => end(true)));
    expect(hook.result.current.progress.value).toBe(0);
    expect(hook.result.current.opacity.value).toBe(1);
    // The same token never plays it again, nor does a change of Reduce Motion.
    native.animationEnds = [];
    hook.rerender({ ...initial, reduceMotion: false, peekToken: 1 });
    expect(hook.result.current.progress.value).toBe(0);
  });

  it('slides the peek in 28 pt and springs it back, then lets the frost go', () => {
    const { hook, initial } = setup();
    hook.rerender({ ...initial, peekToken: 1 });
    expect(hook.result.current.frostArmed).toBe(true);
    expect(hint.recordWallSwipePeekPlayed).toHaveBeenCalledOnce();
    // The mock's sequence lands on its last step: back to rest.
    expect(hook.result.current.progress.value).toBe(0);
    expect(hook.result.current.opacity.value).toBe(1);
    act(() => native.animationEnds.forEach((end) => end(true)));
    expect(hook.result.current.frostArmed).toBe(false);
  });

  it('waits for a width before it plays the peek, and counts it only then', () => {
    const { hook, initial } = setup({ width: 0 });
    hook.rerender({ ...initial, width: 0, peekToken: 1 });
    expect(hint.recordWallSwipePeekPlayed).not.toHaveBeenCalled();
    expect(hook.result.current.frostArmed).toBe(false);
    hook.rerender({ ...initial, width: WIDTH, peekToken: 1 });
    expect(hint.recordWallSwipePeekPlayed).toHaveBeenCalledOnce();
    expect(hook.result.current.frostArmed).toBe(true);
  });

  it('draws a story’s frozen frame with the pan off', () => {
    const { hook } = setup({ preview: 0.7 });
    expect(native.config?.enabled).toBe(false);
    expect(hook.result.current.progress.value).toBe(0.7);
    expect(hook.result.current.releaseArmed).toBe(true);
  });
});
