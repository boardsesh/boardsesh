import { useCallback, useEffect, useId, useMemo } from 'react';
import type { BoardName, LitUpHoldsMap } from '@boardsesh/shared-schema';
import { accumulatedMapsToFrameStrings } from '@boardsesh/board-constants/hold-states';
import { usePlaybackEngine } from '@boardsesh/playback-react';

type UseCreateClimbPlaybackInput = {
  /** The editor's live frame list — absolute lit-state snapshots, one per frame. */
  frames: LitUpHoldsMap[];
  boardName: BoardName;
  /** The editor's cursor. Painting targets this frame. */
  currentFrameIndex: number;
  goToFrame: (index: number) => void;
  /** The setter's authored per-frame pace, in ms — what the climb will publish with. */
  paceMs: number;
};

export type CreateClimbPlayback = {
  /** True once the climb is a route (more than one frame). */
  isAnimatable: boolean;
  isPlaying: boolean;
  speed: number;
  /** Native per-frame pace (ms) — lets the transport glide its progress cue. */
  paceMs: number;
  /** The active frame as a flat BLE string, ready for the wall. */
  currentFrameString: string;
  play: () => void;
  pause: () => void;
  seek: (index: number) => void;
  setSpeed: (speed: number) => void;
};

/**
 * Plays the work-in-progress route inside the create drawer, so a setter can
 * watch the moves before publishing instead of having to publish first.
 *
 * Composes the shared, renderer-agnostic playback engine over the editor's own
 * frame list. Deliberately NOT `useMobilePlayback`: that one is bound to a saved
 * `Climb` and to the party-sync publish/subscribe seam, and a work-in-progress
 * must never be broadcast to the crew (hence no `externalState` and no
 * `onLocalStateChange` here).
 *
 * Pace is the setter's own authored value, which is what `handleSave` now writes
 * as the climb's `frames_pace`. So "0.8s" in the creator is honestly the shipped
 * speed: the control authors the pace, it is not just a preview aid.
 */
export function useCreateClimbPlayback({
  frames,
  boardName,
  currentFrameIndex,
  goToFrame,
  paceMs,
}: UseCreateClimbPlaybackInput): CreateClimbPlayback {
  const frameStrings = useMemo(() => accumulatedMapsToFrameStrings(frames, boardName), [frames, boardName]);
  const playbackClientId = useId();

  const engine = usePlaybackEngine({
    frames,
    frameStrings,
    paceMs,
    clientId: playbackClientId,
  });

  const { frameIndex, isPlaying, seek: engineSeek } = engine;

  // The engine cannot BE the editor's cursor: it resets to frame 0 whenever
  // `frameStrings` change, which is every paint stroke. So the two are synced in
  // one direction at a time, keyed on `isPlaying` so they can never echo.
  //
  // A: while playing, the clock drives the editor. The board art paints from the
  // reducer's active frame, so it follows for free — and so does the paint
  // target, which stays the frame you are watching.
  useEffect(() => {
    if (!isPlaying) return;
    if (frameIndex === currentFrameIndex) return;
    goToFrame(frameIndex);
  }, [isPlaying, frameIndex, currentFrameIndex, goToFrame]);

  // B: while paused, the editor drives the clock. Re-anchors the engine after a
  // paint / duplicate / delete moved the cursor, which also guarantees `play()`
  // reads a current frame index (seek-then-play in one tick would read a stale
  // ref inside the engine).
  useEffect(() => {
    if (isPlaying) return;
    if (frameIndex === currentFrameIndex) return;
    engineSeek(currentFrameIndex);
  }, [isPlaying, frameIndex, currentFrameIndex, engineSeek]);

  const seek = useCallback(
    (index: number) => {
      goToFrame(index);
      engineSeek(index);
    },
    [goToFrame, engineSeek],
  );

  // Memoised: this object is handed back through the screen controller, which
  // CreateDrawer receives as a prop, and a frame tick must not hand every child
  // a fresh object.
  return useMemo<CreateClimbPlayback>(
    () => ({
      isAnimatable: engine.isAnimatable,
      isPlaying: engine.isPlaying,
      speed: engine.speed,
      paceMs,
      currentFrameString: engine.currentFrameString,
      play: engine.play,
      pause: engine.pause,
      seek,
      setSpeed: engine.setSpeed,
    }),
    [
      engine.isAnimatable,
      engine.isPlaying,
      engine.speed,
      engine.currentFrameString,
      paceMs,
      engine.play,
      engine.pause,
      engine.setSpeed,
      seek,
    ],
  );
}
