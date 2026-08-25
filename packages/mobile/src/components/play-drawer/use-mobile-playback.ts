import { useCallback, useEffect, useId, useMemo, useState } from 'react';
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
import { useBleFrameWriter } from '../../lib/ble/use-ble-frame-writer';

type UseMobilePlaybackInput = {
  climb: Climb | null | undefined;
  boardName: BoardName;
  /** Mirror state — frames are flipped before they hit the board. */
  mirrored: boolean;
  /** Gates the BLE write loop only; the peer subscription stays armed regardless. */
  isOpen: boolean;
  /**
   * True while the drawer shows a preview: playback keeps animating ON-SCREEN,
   * but no frame reaches a connected wall. Without this, merely opening a
   * preview of a multi-frame climb replaces the physical wall — the exact
   * promise the Browsing chrome makes ("the wall stays put") broken by the
   * writer below. The live climb's frames resume flowing when the preview
   * clears (the climb-change reset re-arms the first-frame flush).
   */
  suppressWallWrites: boolean;
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
  suppressWallWrites,
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

  const handleLocalStateChange = useCallback(
    (next: LocalPlaybackState) => {
      if (!climbUuid) return;
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

  // --- BLE frame writer ---
  // Extracted to `useBleFrameWriter` so the create drawer's route preview drives
  // the wall through exactly the same latest-wins drain (#4634).
  const { currentFrameString, isAnimatable } = playback;
  const bluetoothConnected = bluetooth?.isConnected ?? false;
  const wallFrame = !isOpen || suppressWallWrites || !isAnimatable || !bluetoothConnected ? null : currentFrameString;
  useBleFrameWriter({
    frame: wallFrame,
    send: bluetooth?.sendFramesToBoard,
    mirrored,
    resetKey: climbUuid,
  });

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
