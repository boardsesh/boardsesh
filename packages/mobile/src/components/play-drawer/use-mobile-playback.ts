import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { BoardName, Climb } from '@boardsesh/shared-schema';
import {
  useClimbFrames,
  usePlaybackEngine,
  type ExternalPlaybackState,
  type LocalPlaybackState,
  type PeerFrameMismatch,
} from '@boardsesh/playback-react';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '../../lib/analytics';
import { useQueueActions } from '../../providers/queue-provider';
import { useOptionalBluetoothContext } from '../../providers/bluetooth-provider';

type UseMobilePlaybackInput = {
  climb: Climb | null | undefined;
  boardName: BoardName;
  /** Mirror state — frames are flipped before they hit the board. */
  mirrored: boolean;
  /** Gates the BLE write loop only; the peer subscription stays armed regardless. */
  isOpen: boolean;
  /**
   * The climb on screen is a PREVIEW — not what the wall or the shared queue is
   * on. Playback then animates locally and reaches nothing outside the phone:
   * no BLE frame writes (the wall keeps the live climb's frames; they resume
   * when the preview clears — the climb-change reset re-arms the first-frame
   * flush) and no playback broadcast (a peer following a route the crew never
   * agreed to play would be the same intrusion one hop further out). Inbound
   * peer state stays subscribed: watching what the crew is doing is exactly
   * what browsing is. Required, not defaulted — every call site must decide.
   */
  viewOnly: boolean;
  /**
   * The climb on screen belongs to a DIFFERENT board than the connected one, so
   * its hold ids address the wrong wall and a frame write would light the wrong
   * holds (#5099). Frames only: the playback state still reaches the crew — it is
   * this wall that cannot show it, not the route that is private. Optional
   * because most call sites have no board to disagree with.
   */
  suppressWallWrites?: boolean;
  /**
   * Fired once per user-initiated `play()` on a route. Analytics seam: mobile
   * has no analytics transport yet, so the play drawer leaves this undefined.
   * Wiring it later (e.g. a 'Route Played' event) is a one-liner here.
   */
  onRoutePlayed?: () => void;
};

export type UseMobilePlaybackOutput = {
  /** True when the climb has more than one frame (controls should render). */
  isAnimatable: boolean;
  /** Total displayable frames. */
  frameCount: number;
  /** Currently displayed frame index. */
  frameIndex: number;
  /** Current frame's flat BLE string — feed to the board renderer override. */
  currentFrameString: string;
  isPlaying: boolean;
  speed: number;
  /** Native per-frame pace (ms) — lets the UI glide a progress cue at the playback cadence. */
  paceMs: number;
  /**
   * True while a party peer is counting this climb's frames differently to us
   * (they're on a build with a different frames reader). We stop following
   * their playback rather than jumping to a frame that doesn't line up.
   */
  peerFrameMismatch: boolean;
  play: () => void;
  pause: () => void;
  seek: (frameIndex: number) => void;
  setSpeed: (speed: number) => void;
};

/**
 * Mobile orchestrator for multi-frame route playback. Composes the shared,
 * renderer-agnostic playback engine + frame decoder with mobile's BLE transport
 * and the queue provider's party-sync seam. Single-frame climbs (boulders)
 * short-circuit: `isAnimatable` is false and every control is a no-op, so the
 * play drawer renders exactly as before.
 */
export function useMobilePlayback({
  climb,
  boardName,
  mirrored,
  isOpen,
  viewOnly,
  suppressWallWrites = false,
  onRoutePlayed,
}: UseMobilePlaybackInput): UseMobilePlaybackOutput {
  const { subscribeToPlaybackEvents, publishPlaybackState } = useQueueActions();
  const bluetooth = useOptionalBluetoothContext();
  // Stable per-hook id so the engine can suppress echoes of its own broadcasts.
  const playbackClientId = useId();

  const { frames, frameStrings, paceMs } = useClimbFrames(climb, boardName);
  const climbUuid = climb?.uuid ?? null;

  // Inbound peer playback state (party mode). Cleared when the climb changes so
  // a stale peer position never bleeds across climbs.
  const [externalPlayback, setExternalPlayback] = useState<ExternalPlaybackState | null>(null);

  useEffect(() => {
    if (!climbUuid) {
      setExternalPlayback(null);
      return;
    }
    setExternalPlayback(null);
    const unsubscribe = subscribeToPlaybackEvents((event) => {
      if (event.climbUuid !== climbUuid) return;
      setExternalPlayback({
        frameIndex: event.frameIndex,
        // Null from peers that predate the field — the engine falls back to its
        // legacy clamp when there's nothing to compare against.
        frameCount: event.frameCount ?? null,
        isPlaying: event.isPlaying,
        speed: event.speed,
        paceMs: event.paceMs,
        anchorTimestamp: Number(event.anchorTimestamp),
        clientId: event.clientId,
      });
    });
    return unsubscribe;
  }, [climbUuid, subscribeToPlaybackEvents]);

  // Read through a ref so the engine keeps ONE `onLocalStateChange` identity for
  // the drawer's lifetime — a preview being pinned must not look to the engine
  // like a new listener.
  const viewOnlyRef = useRef(viewOnly);
  viewOnlyRef.current = viewOnly;

  const handleLocalStateChange = useCallback(
    (next: LocalPlaybackState) => {
      if (!climbUuid) return;
      // Browsing broadcasts nothing (see `viewOnly`).
      if (viewOnlyRef.current) return;
      void publishPlaybackState({
        climbUuid,
        frameIndex: next.frameIndex,
        // Lets peers notice we read this climb's frames differently instead of
        // clamping our index into their range (issue #3989).
        frameCount: next.frameCount,
        isPlaying: next.isPlaying,
        speed: next.speed,
        paceMs: next.paceMs,
        clientId: playbackClientId,
      });
    },
    [climbUuid, publishPlaybackState, playbackClientId],
  );

  // Telemetry seam for the frame-count disagreement. Fires once per stretch of
  // mismatched peer events, so a stale peer scrubbing a slider can't flood it.
  const handlePeerFrameMismatch = useCallback(
    ({ peerFrameCount, localFrameCount }: PeerFrameMismatch) => {
      track(SHARED_EVENTS.PlaybackPeerFrameMismatch, {
        peerFrameCount,
        localFrameCount,
        boardName,
      });
    },
    [boardName],
  );

  const playback = usePlaybackEngine({
    frames,
    frameStrings,
    paceMs,
    clientId: playbackClientId,
    externalState: externalPlayback,
    onLocalStateChange: handleLocalStateChange,
    onPeerFrameMismatch: handlePeerFrameMismatch,
  });

  // --- Latest-wins BLE frame writer ---
  // sendFramesToBoard serialises writes across all callers (its writeChainRef
  // mutex, mirroring web's), so overlapping calls can no longer interleave at
  // the GATT boundary. This drain still matters for a different reason: it
  // collapses animation-frame bursts to the newest frame instead of queueing
  // every intermediate frame behind the mutex, which would let the wall lag
  // arbitrarily far behind the on-screen playback.
  const isWritingFrameRef = useRef(false);
  const pendingFrameRef = useRef<string | null>(null);
  const lastSentFrameRef = useRef<string | null>(null);
  const mirroredRef = useRef(mirrored);
  mirroredRef.current = mirrored;

  // Reset the write trackers on climb change so the new climb's first frame
  // always flushes.
  useEffect(() => {
    lastSentFrameRef.current = null;
    pendingFrameRef.current = null;
  }, [climbUuid]);

  const { currentFrameString, isAnimatable } = playback;
  const bluetoothConnected = bluetooth?.isConnected ?? false;

  useEffect(() => {
    // `viewOnly` first: the drawer showing a preview is the one case where every
    // other condition here can be true and the write would still be wrong — the
    // board is lit with the LIVE climb, and this frame belongs to a climb nobody
    // committed. `suppressWallWrites` is the other wrong write: right climb,
    // wrong wall.
    if (viewOnly || suppressWallWrites || !isOpen || !isAnimatable || !bluetoothConnected || !bluetooth) return;
    const frame = currentFrameString;
    if (!frame || frame === lastSentFrameRef.current) return;
    if (isWritingFrameRef.current) {
      pendingFrameRef.current = frame;
      return;
    }
    isWritingFrameRef.current = true;
    const sendFramesToBoard = bluetooth.sendFramesToBoard;
    const drain = async () => {
      let toSend: string | null = frame;
      try {
        while (toSend !== null) {
          const next: string = toSend;
          if (next === lastSentFrameRef.current) {
            toSend = pendingFrameRef.current;
            pendingFrameRef.current = null;
            continue;
          }
          lastSentFrameRef.current = next;
          try {
            await sendFramesToBoard(next, mirroredRef.current);
          } catch (error) {
            // Best-effort: a dropped frame self-heals on the next tick. Dev-log
            // only (mobile has no analytics transport for a 'BLE Frame Send
            // Failed' event yet).
            if (__DEV__) console.warn('[mobile-playback] BLE frame send failed', error);
          }
          toSend = pendingFrameRef.current;
          pendingFrameRef.current = null;
        }
      } finally {
        isWritingFrameRef.current = false;
      }
    };
    void drain();
  }, [viewOnly, suppressWallWrites, isOpen, isAnimatable, bluetoothConnected, bluetooth, currentFrameString]);

  const play = useCallback(() => {
    // Fire the analytics seam only on a deliberate user play of a route — peer
    // convergence sets isPlaying inside the engine and never calls play().
    if (playback.isAnimatable) onRoutePlayed?.();
    playback.play();
  }, [playback, onRoutePlayed]);

  // Memoise the output so a frame tick doesn't hand the play drawer a new object
  // every render (parity with web's use-drawer-playback). `playback` is already
  // a stable useMemo from the engine and `play` is a stable useCallback.
  return useMemo<UseMobilePlaybackOutput>(
    () => ({
      isAnimatable: playback.isAnimatable,
      frameCount: frameStrings.length,
      frameIndex: playback.frameIndex,
      currentFrameString: playback.currentFrameString,
      isPlaying: playback.isPlaying,
      speed: playback.speed,
      paceMs,
      peerFrameMismatch: playback.peerFrameMismatch,
      play,
      pause: playback.pause,
      seek: playback.seek,
      setSpeed: playback.setSpeed,
    }),
    [playback, frameStrings.length, paceMs, play],
  );
}
