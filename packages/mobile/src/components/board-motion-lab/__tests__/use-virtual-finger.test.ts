// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CarouselVirtualFinger } from '../../play-drawer/use-carousel-gesture';
import type { FingerBeat, FingerScript } from '../types';

/**
 * A stand-in for Reanimated's UI runtime: shared values are refs, work sent to
 * the UI thread runs at once, and the one frame callback runs when a test
 * advances the clock, only while it is active, with the closure of the latest
 * commit, as the real registration effect leaves it.
 */
const ui = vi.hoisted(() => ({
  now: 0,
  frame: null as null | { isActive: boolean; callback: (info: { timestamp: number }) => void },
}));

vi.mock('react-native-reanimated', async () => {
  const { useEffect, useRef } = await import('react');
  return {
    useSharedValue: <Value>(initial: Value) => {
      const shared = useRef<{ value: Value } | null>(null);
      shared.current ??= { value: initial };
      return shared.current;
    },
    runOnUI:
      <Args extends unknown[]>(work: (...args: Args) => void) =>
      (...args: Args) =>
        work(...args),
    runOnJS:
      <Args extends unknown[]>(work: (...args: Args) => void) =>
      (...args: Args) =>
        work(...args),
    useFrameCallback: (callback: (info: { timestamp: number }) => void, autostart = true) => {
      const handle = useRef<{
        isActive: boolean;
        callbackId: number;
        callback: (info: { timestamp: number }) => void;
        setActive: (active: boolean) => void;
      } | null>(null);
      if (handle.current === null) {
        const created = {
          isActive: autostart,
          callbackId: 1,
          callback,
          setActive: (active: boolean) => {
            created.isActive = active;
          },
        };
        handle.current = created;
        ui.frame = created;
      }
      const current = handle.current;
      useEffect(() => {
        current.callback = callback;
      }, [current, callback]);
      return current;
    },
  };
});

const { advanceFinger, FINGER_START, useVirtualFinger } = await import('../use-virtual-finger');

const DRAG: readonly FingerBeat[] = [
  { kind: 'down', atMs: 0 },
  { kind: 'move', atMs: 100, translationX: -100 },
  { kind: 'move', atMs: 200, translationX: -60 },
  { kind: 'up', atMs: 250, velocityX: -900 },
  { kind: 'wait', atMs: 400 },
];

describe('advanceFinger', () => {
  it('does nothing before the first beat', () => {
    const beats: FingerBeat[] = [{ kind: 'down', atMs: 50 }];
    expect(advanceFinger(beats, FINGER_START, 20)).toEqual({ playhead: FINGER_START, actions: [], done: false });
  });

  it('puts the finger down, then moves it linearly between move beats', () => {
    const first = advanceFinger(DRAG, FINGER_START, 25);
    expect(first.actions).toEqual([{ kind: 'down' }, { kind: 'move', translationX: -25 }]);
    const second = advanceFinger(DRAG, first.playhead, 150);
    // -100 reached exactly at 100 ms, then half way to -60.
    expect(second.actions).toEqual([
      { kind: 'move', translationX: -100 },
      { kind: 'move', translationX: -80 },
    ]);
    expect(second.done).toBe(false);
  });

  it('lands on the last move before the release, whatever the frame gap', () => {
    const { actions, playhead, done } = advanceFinger(DRAG, FINGER_START, 260);
    expect(actions).toEqual([
      { kind: 'down' },
      { kind: 'move', translationX: -100 },
      { kind: 'move', translationX: -60 },
      { kind: 'up', velocityX: -900 },
    ]);
    expect(playhead.down).toBe(false);
    expect(done).toBe(false);
    expect(advanceFinger(DRAG, playhead, 400)).toMatchObject({ actions: [], done: true });
  });

  it('holds still while waiting with the finger down', () => {
    const beats: FingerBeat[] = [
      { kind: 'down', atMs: 0 },
      { kind: 'move', atMs: 100, translationX: -40 },
      { kind: 'up', atMs: 300, velocityX: 0 },
    ];
    const moved = advanceFinger(beats, FINGER_START, 100);
    expect(advanceFinger(beats, moved.playhead, 200).actions).toEqual([]);
  });

  it('lifts a finger the script leaves down, at rest', () => {
    const beats: FingerBeat[] = [
      { kind: 'down', atMs: 0 },
      { kind: 'move', atMs: 50, translationX: -30 },
    ];
    const { actions, done, playhead } = advanceFinger(beats, FINGER_START, 60);
    expect(actions.at(-1)).toEqual({ kind: 'up', velocityX: 0 });
    expect(done).toBe(true);
    expect(playhead.down).toBe(false);
  });

  it('ignores moves and lifts while the finger is up', () => {
    const beats: FingerBeat[] = [
      { kind: 'move', atMs: 10, translationX: -30 },
      { kind: 'up', atMs: 20, velocityX: -500 },
      { kind: 'down', atMs: 30 },
      { kind: 'move', atMs: 40, translationX: 20 },
    ];
    const { actions } = advanceFinger(beats, FINGER_START, 35);
    expect(actions).toEqual([{ kind: 'down' }, { kind: 'move', translationX: 10 }]);
  });

  it('played frame by frame, moves one way and lets go once', () => {
    let playhead = FINGER_START;
    const all = [];
    for (let elapsed = 0; elapsed <= 420; elapsed += 16.67) {
      const step = advanceFinger(DRAG, playhead, elapsed);
      playhead = step.playhead;
      all.push(...step.actions);
    }
    expect(all[0]).toEqual({ kind: 'down' });
    expect(all.filter((action) => action.kind === 'down')).toHaveLength(1);
    expect(all.filter((action) => action.kind === 'up')).toEqual([{ kind: 'up', velocityX: -900 }]);
    const lastMove = all.filter((action) => action.kind === 'move').at(-1);
    expect(lastMove).toEqual({ kind: 'move', translationX: -60 });
  });
});

/** Frames 16 ms apart until `untilMs` on the clock. */
function playFrames(untilMs: number) {
  act(() => {
    while (ui.now < untilMs) {
      ui.now += 16;
      if (ui.frame?.isActive) ui.frame.callback({ timestamp: ui.now });
    }
  });
}

function fakeFinger() {
  return { down: vi.fn(), move: vi.fn(), up: vi.fn() } satisfies CarouselVirtualFinger;
}

type Run = { script: FingerScript; runId: number } | null;
const SCRIPT: FingerScript = { id: 'drag', label: 'Drag', beats: DRAG };

/** `hasCarousel` false is a stage that draws no board (no bundled art, no climbs). */
type StageProps = { run: Run; hasCarousel?: boolean };

function mountFinger(initialRun: Run = null, slowdown = 1, initialHasCarousel = true) {
  const onDone = vi.fn();
  const initialProps: StageProps = { run: initialRun, hasCarousel: initialHasCarousel };
  const hook = renderHook(
    ({ run, hasCarousel = true }: StageProps) => useVirtualFinger(run, { slowdown, hasCarousel, onDone }),
    { initialProps },
  );
  /** What the carousel does as it mounts, or is taken down (null). */
  const giveFinger = (finger: CarouselVirtualFinger | null) => act(() => hook.result.current(finger));
  return { ...hook, onDone, giveFinger };
}

describe('useVirtualFinger', () => {
  beforeEach(() => {
    ui.now = 0;
    ui.frame = null;
  });

  it('plays a run through the finger and reports it once', () => {
    const finger = fakeFinger();
    const stage = mountFinger();
    stage.giveFinger(finger);
    stage.rerender({ run: { script: SCRIPT, runId: 1 } });
    playFrames(600);
    expect(finger.down).toHaveBeenCalledOnce();
    expect(finger.move.mock.calls.at(-1)).toEqual([-60]);
    expect(finger.up).toHaveBeenCalledExactlyOnceWith(-900);
    expect(stage.onDone).toHaveBeenCalledExactlyOnceWith(1);
    expect(ui.frame?.isActive).toBe(false);
  });

  it('waits for the board when the run comes first', () => {
    const finger = fakeFinger();
    const stage = mountFinger({ script: SCRIPT, runId: 1 });
    playFrames(100);
    stage.giveFinger(finger);
    playFrames(700);
    expect(finger.down).toHaveBeenCalledOnce();
    expect(stage.onDone).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('never replays a finished run on a remounted carousel', () => {
    const first = fakeFinger();
    const stage = mountFinger();
    stage.giveFinger(first);
    stage.rerender({ run: { script: SCRIPT, runId: 1 } });
    playFrames(600);
    // A slider moved: the carousel is rebuilt for the new transition.
    const second = fakeFinger();
    stage.giveFinger(null);
    stage.giveFinger(second);
    playFrames(1500);
    expect(second.down).not.toHaveBeenCalled();
    expect(second.move).not.toHaveBeenCalled();
    expect(stage.onDone).toHaveBeenCalledOnce();
  });

  it('a remount mid-run ends the run where it is: no replay, no finger lifted', () => {
    const first = fakeFinger();
    const stage = mountFinger();
    stage.giveFinger(first);
    stage.rerender({ run: { script: SCRIPT, runId: 1 } });
    playFrames(120);
    expect(first.down).toHaveBeenCalledOnce();
    const movesBefore = first.move.mock.calls.length;

    const second = fakeFinger();
    stage.giveFinger(null);
    stage.giveFinger(second);
    expect(stage.onDone).toHaveBeenCalledExactlyOnceWith(1);
    playFrames(1500);
    expect(first.up).not.toHaveBeenCalled();
    expect(first.move.mock.calls.length).toBe(movesBefore);
    expect(second.down).not.toHaveBeenCalled();
    expect(second.up).not.toHaveBeenCalled();
    expect(stage.onDone).toHaveBeenCalledOnce();
  });

  it('Stop mid-script lets go of the finger where it is, and reports nothing', () => {
    const finger = fakeFinger();
    const stage = mountFinger();
    stage.giveFinger(finger);
    stage.rerender({ run: { script: SCRIPT, runId: 1 } });
    playFrames(120);
    stage.rerender({ run: null });
    expect(finger.up).toHaveBeenCalledExactlyOnceWith(0);
    const movesAtStop = finger.move.mock.calls.length;
    playFrames(1000);
    expect(finger.move.mock.calls.length).toBe(movesAtStop);
    expect(finger.up).toHaveBeenCalledOnce();
    expect(stage.onDone).not.toHaveBeenCalled();
  });

  it('a new run id plays again from the top, letting go of the last one first', () => {
    const finger = fakeFinger();
    const stage = mountFinger();
    stage.giveFinger(finger);
    stage.rerender({ run: { script: SCRIPT, runId: 1 } });
    playFrames(120);
    stage.rerender({ run: { script: SCRIPT, runId: 2 } });
    expect(finger.up).toHaveBeenCalledExactlyOnceWith(0);
    playFrames(1000);
    expect(finger.down).toHaveBeenCalledTimes(2);
    expect(finger.up.mock.calls.at(-1)).toEqual([-900]);
    expect(stage.onDone).toHaveBeenCalledExactlyOnceWith(2);
  });

  it('with no carousel, reports a run done at once and never plays it', () => {
    const stage = mountFinger(null, 1, false);
    stage.rerender({ run: { script: SCRIPT, runId: 1 }, hasCarousel: false });
    expect(stage.onDone).toHaveBeenCalledExactlyOnceWith(1);
    playFrames(600);
    expect(ui.frame?.isActive).toBe(false);
    expect(stage.onDone).toHaveBeenCalledOnce();
  });

  it('a carousel that goes away for good mid-run reports the run once', () => {
    const finger = fakeFinger();
    const stage = mountFinger();
    stage.giveFinger(finger);
    stage.rerender({ run: { script: SCRIPT, runId: 1 } });
    playFrames(120);
    // The board lost its art: the carousel unmounts and is not replaced.
    stage.giveFinger(null);
    stage.rerender({ run: { script: SCRIPT, runId: 1 }, hasCarousel: false });
    playFrames(1000);
    expect(stage.onDone).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('stretches the beats by the slowdown', () => {
    const finger = fakeFinger();
    const stage = mountFinger(null, 4);
    stage.giveFinger(finger);
    stage.rerender({ run: { script: SCRIPT, runId: 1 } });
    // The release is at 250 clock ms: 1,000 real ms at quarter speed.
    playFrames(960);
    expect(finger.up).not.toHaveBeenCalled();
    playFrames(1100);
    expect(finger.up).toHaveBeenCalledExactlyOnceWith(-900);
  });
});
