import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LitUpHoldsMap } from '@boardsesh/shared-schema';
import { MIN_PACE_MS } from './pace';

export type PlaybackSnapshot = {
  /** Index in `frameStrings` currently displayed. */
  frameIndex: number;
  /** Whether the engine is auto-advancing. */
  isPlaying: boolean;
  /** Playback multiplier (1 = native, 2 = twice as fast). */
  speed: number;
  /** Wall-clock ms at which `frameIndex` became current. */
  anchorTimestamp: number;
};

/**
 * Peer state arriving over the wire. `frameCount` is optional and nullable
 * because publishers older than the field omit it entirely — see
 * `LocalPlaybackState` for the outbound shape, where it is always present.
 */
export type ExternalPlaybackState = PlaybackSnapshot & {
  /** Native per-frame pace from the climb metadata. */
  paceMs: number;
  /** Identifier of the client that produced this state. Used for echo suppression. */
  clientId: string | null;
  /**
   * Frames the publishing peer's reader produced. When it disagrees with our
   * own frame list the two sides are counting frames differently and the
   * event is ignored rather than clamped into range. Absent from peers that
   * predate the field — those keep the legacy clamp.
   */
  frameCount?: number | null;
};

/**
 * State the local engine emits for broadcast. Distinct from
 * `ExternalPlaybackState` purely so `frameCount` can be required here (we
 * always know our own frame count) while staying optional on the inbound side.
 */
export type LocalPlaybackState = PlaybackSnapshot & {
  paceMs: number;
  clientId: string | null;
  /** Frames our reader produced for this climb. Always ≥ 1 — the engine never emits for a frameless climb. */
  frameCount: number;
};

/** Details handed to `onPeerFrameMismatch` when a peer's frame count disagrees. */
export type PeerFrameMismatch = {
  /** Frames the peer reported. */
  peerFrameCount: number;
  /** Frames our own reader produced. */
  localFrameCount: number;
};

type UsePlaybackEngineInput = {
  frames: LitUpHoldsMap[];
  frameStrings: string[];
  paceMs: number;
  /** Stable identifier the engine attaches to its own emitted state. */
  clientId: string;
  /**
   * Inbound state from a peer (party mode). When supplied and `clientId`
   * doesn't match ours, the engine converges to that state.
   */
  externalState?: ExternalPlaybackState | null;
  /** Fires whenever the local engine produces a new state worth broadcasting. */
  onLocalStateChange?: (state: LocalPlaybackState) => void;
  /**
   * Fires on the transition into a frame-count disagreement with a peer
   * (once per stretch of mismatched events, not per event). Telemetry seam —
   * the host wires it to its analytics transport.
   */
  onPeerFrameMismatch?: (mismatch: PeerFrameMismatch) => void;
};

export type UsePlaybackEngineOutput = {
  frameIndex: number;
  isPlaying: boolean;
  speed: number;
  /** Currently displayed snapshot. Empty map when the climb has no frames. */
  currentLitUpHoldsMap: LitUpHoldsMap;
  /** Currently displayed BLE frame string. Empty when the climb has no frames. */
  currentFrameString: string;
  /** Whether the engine has more than one frame (i.e. controls should render). */
  isAnimatable: boolean;
  /**
   * True while a peer is broadcasting a frame count that disagrees with ours,
   * meaning the two clients read this climb's frames differently. Local
   * playback keeps running on its own; the peer is simply not followed.
   * Clears on climb change and as soon as a peer's count agrees again.
   */
  peerFrameMismatch: boolean;
  play: () => void;
  pause: () => void;
  seek: (frameIndex: number) => void;
  setSpeed: (speed: number) => void;
};

/**
 * Walks a multi-frame climb at the climb's native pace, optionally syncing
 * to a peer's state via `externalState`. Single-frame climbs (the common
 * case) short-circuit: the engine never schedules a timer and `play`/`pause`
 * are no-ops.
 *
 * The timer is a self-rescheduling `setTimeout`, not `requestAnimationFrame`
 * — Aurora pace is typically hundreds of ms per step and rAF would just
 * burn CPU. Browser background-tab throttling will visibly stall playback,
 * but the LED board is the source of truth so that's acceptable for v1.
 */
export function usePlaybackEngine({
  frames,
  frameStrings,
  paceMs,
  clientId,
  externalState,
  onLocalStateChange,
  onPeerFrameMismatch,
}: UsePlaybackEngineInput): UsePlaybackEngineOutput {
  const isAnimatable = frameStrings.length > 1;

  const [frameIndex, setFrameIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeedState] = useState(1);
  const [peerFrameMismatch, setPeerFrameMismatch] = useState(false);

  // Refs so the timer callback doesn't capture stale state.
  const frameIndexRef = useRef(frameIndex);
  const isPlayingRef = useRef(isPlaying);
  const speedRef = useRef(speed);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onLocalStateChangeRef = useRef(onLocalStateChange);
  const onPeerFrameMismatchRef = useRef(onPeerFrameMismatch);
  // Mirrors `peerFrameMismatch` so the convergence effect only writes state on
  // a real transition. A stale peer scrubbing a slider republishes constantly;
  // without this every one of those events would queue a render.
  const peerFrameMismatchRef = useRef(peerFrameMismatch);

  frameIndexRef.current = frameIndex;
  isPlayingRef.current = isPlaying;
  speedRef.current = speed;
  onLocalStateChangeRef.current = onLocalStateChange;
  onPeerFrameMismatchRef.current = onPeerFrameMismatch;

  const clearTimer = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const updatePeerFrameMismatch = useCallback((next: boolean) => {
    if (peerFrameMismatchRef.current === next) return;
    peerFrameMismatchRef.current = next;
    setPeerFrameMismatch(next);
  }, []);

  // Reset to frame 0 + paused whenever the underlying climb changes. A frame
  // disagreement is per-climb (it comes out of how each side read THIS climb's
  // frames), so it clears here too.
  const framesKey = frameStrings.join('|');
  useEffect(() => {
    clearTimer();
    setFrameIndex(0);
    setIsPlaying(false);
    updatePeerFrameMismatch(false);
  }, [framesKey, updatePeerFrameMismatch]);

  const emitLocalState = useCallback(
    (nextIndex: number, nextIsPlaying: boolean, nextSpeed: number) => {
      // A frameless climb has nothing to play and nothing meaningful to
      // broadcast — `setSpeed` is the one control that isn't gated on
      // `isAnimatable`, so without this it would publish frameCount: 0.
      if (frameStrings.length === 0) return;
      onLocalStateChangeRef.current?.({
        frameIndex: nextIndex,
        isPlaying: nextIsPlaying,
        speed: nextSpeed,
        anchorTimestamp: Date.now(),
        paceMs,
        clientId,
        frameCount: frameStrings.length,
      });
    },
    [clientId, paceMs, frameStrings.length],
  );

  // Timer driver: a single effect owns the timer for the whole engine life.
  // Re-arms whenever `isPlaying`, `frameStrings.length`, or `paceMs` change.
  // Internal `tick` callback closes over refs so frame/speed changes inside
  // a tick don't re-arm the effect (which would clobber the in-flight timer
  // and visibly stall playback).
  useEffect(() => {
    if (!isPlaying || frameStrings.length <= 1) {
      clearTimer();
      return;
    }
    const scheduleNext = () => {
      const interval = Math.max(MIN_PACE_MS, paceMs / Math.max(speedRef.current, 0.01));
      timerRef.current = setTimeout(tick, interval);
    };
    const tick = () => {
      timerRef.current = null;
      if (!isPlayingRef.current) return;
      const lastIndex = frameStrings.length - 1;
      // Stop at the end instead of looping. Broadcast the stop (unlike the
      // mid-sequence ticks below) so peers also halt on the last frame.
      if (frameIndexRef.current >= lastIndex) {
        isPlayingRef.current = false;
        setIsPlaying(false);
        emitLocalState(lastIndex, false, speedRef.current);
        return;
      }
      const nextIndex = frameIndexRef.current + 1;
      // Update the ref synchronously so back-to-back ticks (e.g. fake timers
      // firing several callbacks inside one `act`) see the advanced index
      // instead of reading the stale value through the next render.
      frameIndexRef.current = nextIndex;
      setFrameIndex(nextIndex);
      // Intentionally do NOT broadcast every tick — peers extrapolate
      // frames from the latest `anchorTimestamp`/`isPlaying`/`speed`/`paceMs`.
      // Only user actions (play/pause/seek/setSpeed) emit external state.
      scheduleNext();
    };
    scheduleNext();
    return clearTimer;
  }, [isPlaying, frameStrings.length, paceMs, emitLocalState]);

  // Converge to external (peer) state when its clientId differs from ours.
  // Peer state arrives over the wire — clamp every numeric field before we
  // trust it. A hostile or buggy peer sending NaN, Infinity, negatives, or
  // out-of-range values would otherwise poison local state and get re-broadcast
  // on the next user action.
  useEffect(() => {
    // Host dropped the peer state (climb change, session left). Nothing left to
    // disagree with, so the notice shouldn't outlive it.
    if (!externalState) {
      updatePeerFrameMismatch(false);
      return;
    }
    if (externalState.clientId && externalState.clientId === clientId) return;
    if (frameStrings.length === 0) return;
    // Frame-count check first, before anything is clamped. A peer whose reader
    // produced a different number of frames is indexing a different sequence:
    // its index N is not our frame N, and clamping it into our range would
    // silently park us on the last frame and stop playback (issue #3989).
    // Stop following instead and let the host say so. Peers that don't send a
    // count (older than the field) keep the legacy clamp — there is nothing to
    // compare against and same-version sessions must not regress.
    const peerFrameCount = externalState.frameCount;
    if (typeof peerFrameCount === 'number' && Number.isInteger(peerFrameCount) && peerFrameCount > 0) {
      if (peerFrameCount !== frameStrings.length) {
        if (!peerFrameMismatchRef.current) {
          onPeerFrameMismatchRef.current?.({
            peerFrameCount,
            localFrameCount: frameStrings.length,
          });
        }
        updatePeerFrameMismatch(true);
        return;
      }
      updatePeerFrameMismatch(false);
    }
    const safeSpeed = Number.isFinite(externalState.speed) ? Math.max(0.1, externalState.speed) : 1;
    const safePaceMs = Number.isFinite(externalState.paceMs)
      ? Math.max(MIN_PACE_MS, externalState.paceMs)
      : MIN_PACE_MS;
    const rawFrameIndex = Number.isFinite(externalState.frameIndex) ? externalState.frameIndex : 0;
    const safeFrameIndex = Math.max(0, Math.min(frameStrings.length - 1, Math.floor(rawFrameIndex)));
    const safeAnchor = Number.isFinite(externalState.anchorTimestamp) ? externalState.anchorTimestamp : Date.now();
    const elapsed = Math.max(0, Date.now() - safeAnchor);
    const effectivePace = Math.max(MIN_PACE_MS, safePaceMs / safeSpeed);
    const stepsAdvanced = externalState.isPlaying && effectivePace > 0 ? Math.floor(elapsed / effectivePace) : 0;
    // Clamp to the last frame instead of wrapping — playback no longer loops,
    // so a peer that extrapolated past the end has stopped on the last frame.
    const lastIndex = frameStrings.length - 1;
    const reachedEnd = externalState.isPlaying && safeFrameIndex + stepsAdvanced >= lastIndex;
    const projected = Math.min(lastIndex, safeFrameIndex + stepsAdvanced);
    setFrameIndex(projected);
    setIsPlaying(externalState.isPlaying && !reachedEnd);
    setSpeedState(safeSpeed);
  }, [externalState, clientId, frameStrings.length, updatePeerFrameMismatch]);

  const play = useCallback(() => {
    if (!isAnimatable) return;
    // Pressing play on the last frame replays from the start — without this
    // the engine would immediately stop again (no looping).
    let startIndex = frameIndexRef.current;
    if (startIndex >= frameStrings.length - 1) {
      startIndex = 0;
      frameIndexRef.current = 0;
      setFrameIndex(0);
    }
    setIsPlaying(true);
    emitLocalState(startIndex, true, speedRef.current);
  }, [isAnimatable, emitLocalState, frameStrings.length]);

  const pause = useCallback(() => {
    if (!isAnimatable) return;
    setIsPlaying(false);
    emitLocalState(frameIndexRef.current, false, speedRef.current);
  }, [isAnimatable, emitLocalState]);

  const seek = useCallback(
    (next: number) => {
      if (frameStrings.length === 0) return;
      const clamped = Math.max(0, Math.min(frameStrings.length - 1, Math.floor(next)));
      setFrameIndex(clamped);
      emitLocalState(clamped, isPlayingRef.current, speedRef.current);
    },
    [frameStrings.length, emitLocalState],
  );

  const setSpeed = useCallback(
    (next: number) => {
      const sanitised = Math.max(0.1, next);
      setSpeedState(sanitised);
      emitLocalState(frameIndexRef.current, isPlayingRef.current, sanitised);
    },
    [emitLocalState],
  );

  const currentLitUpHoldsMap = useMemo<LitUpHoldsMap>(
    () => frames[frameIndex] ?? frames[0] ?? {},
    [frames, frameIndex],
  );
  const currentFrameString = useMemo(
    () => frameStrings[frameIndex] ?? frameStrings[0] ?? '',
    [frameStrings, frameIndex],
  );

  // Returning a memoised object keeps the engine's reference stable across
  // renders that don't change any of its observable state. Callers can then
  // safely pass the engine into `React.memo`'d children or `useMemo` dep
  // arrays without busting on every render.
  return useMemo(
    () => ({
      frameIndex,
      isPlaying,
      speed,
      currentLitUpHoldsMap,
      currentFrameString,
      isAnimatable,
      peerFrameMismatch,
      play,
      pause,
      seek,
      setSpeed,
    }),
    [
      frameIndex,
      isPlaying,
      speed,
      currentLitUpHoldsMap,
      currentFrameString,
      isAnimatable,
      peerFrameMismatch,
      play,
      pause,
      seek,
      setSpeed,
    ],
  );
}
