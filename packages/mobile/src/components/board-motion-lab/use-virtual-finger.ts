/**
 * Plays a scripted swipe (`FingerScript`) through the carousel's virtual finger
 * on the UI thread, one point per display frame, so every variant is recorded
 * with the same input. Nothing crosses to the JS thread until the script ends.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  runOnJS,
  runOnUI,
  useFrameCallback,
  useSharedValue,
  type FrameCallback,
  type FrameInfo,
} from 'react-native-reanimated';
import type { CarouselVirtualFinger } from '../play-drawer/use-carousel-gesture';
import type { FingerBeat, FingerScript } from './types';

/** What the finger does this frame, in order. */
export type FingerAction =
  | { kind: 'down' }
  | { kind: 'move'; translationX: number }
  | { kind: 'up'; velocityX: number };

/** How far through a script the finger is. */
export type FingerPlayhead = {
  /** The first beat not yet reached. */
  next: number;
  /** When (clock ms) and where (board points) the finger was at the last beat reached: a move starts from here. */
  fromMs: number;
  fromX: number;
  down: boolean;
};

export const FINGER_START: FingerPlayhead = { next: 0, fromMs: 0, fromX: 0, down: false };

function clampUnit(value: number): number {
  'worklet';
  return value > 0 ? (value < 1 ? value : 1) : 0;
}

/**
 * The finger `elapsedMs` (clock ms) into `beats`: every beat reached since
 * `playhead` in order, then a point on the move under way, linear between its
 * start and its end. A finger left down at the end of the script is lifted at
 * rest. Pure, and a worklet.
 */
export function advanceFinger(
  beats: readonly FingerBeat[],
  playhead: FingerPlayhead,
  elapsedMs: number,
): { playhead: FingerPlayhead; actions: FingerAction[]; done: boolean } {
  'worklet';
  const actions: FingerAction[] = [];
  let { next, fromMs, fromX, down } = playhead;
  while (next < beats.length && beats[next].atMs <= elapsedMs) {
    const beat = beats[next];
    if (beat.kind === 'down') {
      if (!down) actions.push({ kind: 'down' });
      down = true;
      fromX = 0;
    } else if (beat.kind === 'move') {
      // Lands exactly on the beat, whatever the frame rate, so a release reads it.
      if (down) actions.push({ kind: 'move', translationX: beat.translationX });
      fromX = beat.translationX;
    } else if (beat.kind === 'up') {
      if (down) actions.push({ kind: 'up', velocityX: beat.velocityX });
      down = false;
      fromX = 0;
    }
    fromMs = beat.atMs;
    next += 1;
  }
  const pending = next < beats.length ? beats[next] : null;
  if (down && pending !== null && pending.kind === 'move') {
    const span = pending.atMs - fromMs;
    const amount = span > 0 ? clampUnit((elapsedMs - fromMs) / span) : 1;
    actions.push({ kind: 'move', translationX: fromX + (pending.translationX - fromX) * amount });
  }
  const done = next >= beats.length;
  if (done && down) {
    actions.push({ kind: 'up', velocityX: 0 });
    down = false;
  }
  return { playhead: { next, fromMs, fromX, down }, actions, done };
}

/** The clock length of a script: its last beat. */
export function fingerScriptMs(script: FingerScript): number {
  return script.beats.reduce((latest, beat) => Math.max(latest, beat.atMs), 0);
}

type Playing = {
  /** A run is playing; false at rest and once it has finished. */
  active: boolean;
  runId: number;
  /** The frame timestamp the run started at; null until its first frame. */
  startedAt: number | null;
  playhead: FingerPlayhead;
};

const IDLE: Playing = { active: false, runId: 0, startedAt: null, playhead: FINGER_START };

type FingerRun = { script: FingerScript; runId: number };

export type VirtualFingerOptions = {
  /** Real milliseconds per clock millisecond: 4 plays a script at quarter speed. */
  slowdown: number;
  /**
   * The stage draws a carousel to hand over a finger. False when it draws
   * none (no bundled art, no climbs): no finger will ever come.
   */
  hasCarousel: boolean;
  /** Runs on the JS thread with the run's id when a run ends by itself. */
  onDone?: (runId: number) => void;
};

/**
 * Plays `run` through the carousel's virtual finger. Returns the callback the
 * carousel hands its finger to (`SwipeBoardCarousel`'s `onVirtualFinger`).
 *
 * - A run starts once, when its `runId` is new: a carousel remounted for a new
 *   variant, slider, speed or Reduce Motion never replays it. Keep this hook
 *   above the keyed carousel so it outlives those remounts.
 * - A new `runId` restarts from the top, letting go of a finger the last run
 *   left down.
 * - `run` set to null stops the run in flight and lets go of its finger where
 *   it is, as a touch let go would. `onDone` is not called: the caller stopped it.
 * - The carousel going away mid-run (a remount) ends the run where it is: the
 *   board it was swiping is gone, and the new one never had the finger down.
 *   `onDone(runId)` reports it, so a caller waiting on it moves on.
 * - With no carousel (`hasCarousel` false) a run ends as it starts and
 *   `onDone(runId)` reports it: waiting for a finger would hold it for good.
 * - `slowdown` stretches the beats' times (4 = quarter speed). Release
 *   velocities are left alone, so every speed commits the same swipes.
 * - `onDone(runId)` runs on the JS thread when a run reaches its last beat.
 */
export function useVirtualFinger(
  run: FingerRun | null,
  { slowdown, hasCarousel, onDone }: VirtualFingerOptions,
): (finger: CarouselVirtualFinger | null) => void {
  const beats = useSharedValue<readonly FingerBeat[]>([]);
  const playing = useSharedValue<Playing>(IDLE);
  const slowdownValue = useSharedValue(slowdown);
  useEffect(() => {
    slowdownValue.value = Number.isFinite(slowdown) && slowdown > 0 ? slowdown : 1;
  }, [slowdown, slowdownValue]);

  const [finger, setFinger] = useState<CarouselVirtualFinger | null>(null);
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);
  // The last run started, never started again; and the one playing now.
  const startedRunRef = useRef<number | null>(null);
  const activeRunRef = useRef<number | null>(null);
  const frameCallbackRef = useRef<FrameCallback | null>(null);

  const finish = useCallback((runId: number) => {
    // Already stopped, ended by a remount, or replaced: reported (or not) then.
    if (activeRunRef.current !== runId) return;
    activeRunRef.current = null;
    frameCallbackRef.current?.setActive(false);
    onDoneRef.current?.(runId);
  }, []);

  const onFrame = useCallback(
    (frameInfo: FrameInfo) => {
      'worklet';
      const current = playing.value;
      if (finger === null || !current.active) return;
      const startedAt = current.startedAt ?? frameInfo.timestamp;
      const elapsedMs = (frameInfo.timestamp - startedAt) / slowdownValue.value;
      const advanced = advanceFinger(beats.value, current.playhead, elapsedMs);
      for (const action of advanced.actions) {
        if (action.kind === 'down') finger.down();
        else if (action.kind === 'move') finger.move(action.translationX);
        else finger.up(action.velocityX);
      }
      if (advanced.done) {
        playing.value = IDLE;
        runOnJS(finish)(current.runId);
        return;
      }
      playing.value = { active: true, runId: current.runId, startedAt, playhead: advanced.playhead };
    },
    [finger, playing, beats, slowdownValue, finish],
  );
  const frameCallback = useFrameCallback(onFrame, false);
  useEffect(() => {
    frameCallbackRef.current = frameCallback;
  }, [frameCallback]);

  const handleFinger = useCallback(
    (next: CarouselVirtualFinger | null) => {
      const ended = activeRunRef.current;
      if (ended !== null) {
        activeRunRef.current = null;
        frameCallbackRef.current?.setActive(false);
        // Queued with the carousel's own teardown, ahead of any later frame:
        // nothing drives the finger of a board that is gone.
        runOnUI(() => {
          'worklet';
          playing.value = IDLE;
        })();
        onDoneRef.current?.(ended);
      }
      setFinger(next);
    },
    [playing],
  );

  const runId = run?.runId ?? null;
  const scriptBeats = run?.script.beats ?? null;
  useEffect(() => {
    if (runId === null || scriptBeats === null) {
      if (activeRunRef.current === null) return;
      activeRunRef.current = null;
      frameCallback.setActive(false);
      runOnUI((current: CarouselVirtualFinger | null) => {
        'worklet';
        if (current !== null && playing.value.playhead.down) current.up(0);
        playing.value = IDLE;
      })(finger);
      return;
    }
    if (startedRunRef.current === runId) return;
    if (!hasCarousel) {
      startedRunRef.current = runId;
      onDoneRef.current?.(runId);
      return;
    }
    if (finger === null) return;
    startedRunRef.current = runId;
    activeRunRef.current = runId;
    runOnUI((nextBeats: readonly FingerBeat[], nextRunId: number, current: CarouselVirtualFinger) => {
      'worklet';
      // Replacing a run mid-stroke: its finger lets go first.
      if (playing.value.playhead.down) current.up(0);
      beats.value = nextBeats;
      playing.value = { active: true, runId: nextRunId, startedAt: null, playhead: FINGER_START };
    })(scriptBeats, runId, finger);
    frameCallback.setActive(true);
  }, [runId, scriptBeats, finger, hasCarousel, frameCallback, playing, beats]);

  // The stage going away: stop the clock. The carousel goes with it (reporting
  // the run through `handleFinger`), and its own teardown settles the board.
  useEffect(
    () => () => {
      frameCallbackRef.current?.setActive(false);
      runOnUI(() => {
        'worklet';
        playing.value = IDLE;
      })();
    },
    [playing],
  );

  return handleFinger;
}
