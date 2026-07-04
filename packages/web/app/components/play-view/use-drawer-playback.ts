'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Climb, BoardDetails } from '@/app/lib/types';
import { useClimbFrames } from '../board-renderer/util';
import { usePlaybackEngine, type ExternalPlaybackState } from '@boardsesh/playback-react/use-playback-engine';
import { usePersistentSessionActions } from '../persistent-session';
import { useBluetoothContext } from '../board-bluetooth-control/bluetooth-context';
import { renderBoard } from '@/app/lib/board-render-worker/worker-manager';
import { track } from '@/app/lib/analytics';

type UseDrawerPlaybackInput = {
  currentClimb: Climb | null;
  boardDetails: BoardDetails;
  /** Drawer open state — gates the BLE write loop only. Peer subscription stays armed. */
  isOpen: boolean;
};

type UseDrawerPlaybackOutput = {
  isAnimatable: boolean;
  frameCount: number;
  currentFrameString: string;
  frameIndex: number;
  isPlaying: boolean;
  speed: number;
  play: () => void;
  pause: () => void;
  seek: (index: number) => void;
  setSpeed: (speed: number) => void;
};

/**
 * Multi-frame ("route") playback wiring for the play-view drawer. Owns the
 * engine, the peer-sync subscribe/publish via `usePersistentSessionActions`,
 * and the latest-wins BLE write loop. Single-frame climbs short-circuit
 * because `useClimbFrames` returns a 1-length `frameStrings` and the engine
 * reports `isAnimatable: false`.
 *
 * Peer subscription is unconditional so opening the drawer mid-peer-play
 * converges instead of stuck on frame 0; only the BLE write loop is gated on
 * `isOpen` so the wall doesn't keep receiving frames after the drawer closes.
 */
export function useDrawerPlayback({
  currentClimb,
  boardDetails,
  isOpen,
}: UseDrawerPlaybackInput): UseDrawerPlaybackOutput {
  const playbackClientId = useId();
  const climbFrames = useClimbFrames(currentClimb, boardDetails.board_name);
  const isMirrored = !!currentClimb?.mirrored;
  const isMirroredRef = useRef(isMirrored);
  isMirroredRef.current = isMirrored;

  const { publishPlaybackState, subscribeToQueueEvents } = usePersistentSessionActions();
  const { isConnected: isBluetoothConnected, sendFramesToBoard } = useBluetoothContext();

  const [externalPlayback, setExternalPlayback] = useState<ExternalPlaybackState | null>(null);
  const activeClimbUuid = currentClimb?.uuid;
  const activeClimbBoardType = currentClimb?.boardType;
  const activeClimbLayoutId = currentClimb?.layoutId;

  // Reset peer state on climb change so a stale event from the previous climb
  // can't bleed into the new engine's convergence pass.
  useEffect(() => {
    setExternalPlayback(null);
  }, [activeClimbUuid]);

  useEffect(() => {
    if (!activeClimbUuid) return;
    const unsubscribe = subscribeToQueueEvents((event) => {
      if (event.__typename !== 'PlaybackStateChanged') return;
      if (event.climbUuid !== activeClimbUuid) return;
      setExternalPlayback({
        frameIndex: event.frameIndex,
        isPlaying: event.isPlaying,
        speed: event.speed,
        paceMs: event.paceMs,
        anchorTimestamp: Number(event.anchorTimestamp),
        clientId: event.clientId,
      });
    });
    return unsubscribe;
  }, [activeClimbUuid, subscribeToQueueEvents]);

  const handleLocalPlaybackChange = useCallback(
    (state: ExternalPlaybackState) => {
      if (!activeClimbUuid) return;
      void publishPlaybackState({
        climbUuid: activeClimbUuid,
        frameIndex: state.frameIndex,
        isPlaying: state.isPlaying,
        speed: state.speed,
        paceMs: state.paceMs,
        // Forward our clientId so the server echoes it back on
        // `PlaybackStateChanged`; without this our other tabs/sessions
        // can't suppress echoes of their own state.
        clientId: playbackClientId,
      });
    },
    [activeClimbUuid, publishPlaybackState, playbackClientId],
  );

  const playback = usePlaybackEngine({
    frames: climbFrames.frames,
    frameStrings: climbFrames.frameStrings,
    paceMs: climbFrames.paceMs,
    clientId: playbackClientId,
    externalState: externalPlayback,
    onLocalStateChange: handleLocalPlaybackChange,
  });

  // Latest-wins BLE serialization: Web Bluetooth on Android can't cancel an
  // in-flight GATT operation, so a second `sendFramesToBoard` started before
  // the previous one resolves throws "GATT operation already in progress."
  // Mirror the BluetoothAutoSender pattern: while a write is in flight,
  // store the most recent pending frame; drain on completion.
  const isWritingFrameRef = useRef(false);
  const pendingFrameRef = useRef<string | null>(null);
  const lastSentFrameRef = useRef<string | null>(null);

  useEffect(() => {
    lastSentFrameRef.current = null;
    pendingFrameRef.current = null;
  }, [activeClimbUuid]);

  useEffect(() => {
    if (!isOpen) return;
    if (!isBluetoothConnected) return;
    if (!playback.isAnimatable) return;
    const frame = playback.currentFrameString;
    if (!frame) return;
    if (frame === lastSentFrameRef.current) return;
    if (isWritingFrameRef.current) {
      pendingFrameRef.current = frame;
      return;
    }
    isWritingFrameRef.current = true;
    const drain = async () => {
      let toSend: string | null = frame;
      try {
        while (toSend !== null) {
          const next = toSend;
          if (next === lastSentFrameRef.current) {
            toSend = pendingFrameRef.current;
            pendingFrameRef.current = null;
            continue;
          }
          lastSentFrameRef.current = next;
          try {
            await sendFramesToBoard(next, isMirroredRef.current, undefined, {
              climbUuid: activeClimbUuid,
              climbBoardType: activeClimbBoardType,
              climbLayoutId: activeClimbLayoutId,
              // The AutoSender processes the same current climb and owns the
              // user-visible skip toast — avoid a second toast from this loop.
              suppressIncompatibleToast: true,
            });
          } catch (error) {
            console.error('[useDrawerPlayback] BLE frame send failed:', error);
            track('BLE Frame Send Failed', {
              error: String(error),
              climbUuid: activeClimbUuid,
            });
          }
          toSend = pendingFrameRef.current;
          pendingFrameRef.current = null;
        }
      } finally {
        isWritingFrameRef.current = false;
      }
    };
    void drain();
  }, [
    isOpen,
    isBluetoothConnected,
    sendFramesToBoard,
    playback.isAnimatable,
    playback.currentFrameString,
    activeClimbUuid,
    activeClimbBoardType,
    activeClimbLayoutId,
  ]);

  // Pre-warm every snapshot through the Rust/WASM canvas renderer the moment
  // the drawer opens on a route. The renderer caches by (frames, mirrored)
  // bitmap key, so the engine's first pass through the frames hits warm cache
  // and the on-screen board crossfades cleanly instead of flickering while
  // each snapshot decodes for the first time. The single-frame pre-warm in
  // the drawer (keyed on `currentClimb.frames`) already handles static
  // climbs and the multi-frame source string; this is purely for the
  // per-snapshot strings produced by `useClimbFrames`.
  //
  // Sequential, not parallel: the worker pool serialises anyway and queuing
  // a 40-frame Driftwood as 40 concurrent requests starves the first-frame
  // render the user is actually staring at. Aborts on close, climb-change,
  // and mirror flip.
  const frameStringsKey = climbFrames.frameStrings.join('|');
  useEffect(() => {
    if (!isOpen) return;
    if (!playback.isAnimatable) return;
    if (climbFrames.frameStrings.length <= 1) return;
    let cancelled = false;
    const warm = async () => {
      for (const frame of climbFrames.frameStrings) {
        if (cancelled) return;
        try {
          await renderBoard({ boardDetails, frames: frame, mirrored: isMirrored });
        } catch (error) {
          if (process.env.NODE_ENV === 'development') {
            console.info('[useDrawerPlayback] frame pre-warm failed:', error);
          }
        }
      }
    };
    void warm();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- climbFrames.frameStrings is captured via frameStringsKey
  }, [isOpen, playback.isAnimatable, frameStringsKey, isMirrored, boardDetails]);

  // Track deliberate user Play presses on a route. Peer-driven playback
  // converges via `setIsPlaying` inside the engine and never calls `play()`,
  // so this stays a user-only signal (no double counting from party sync).
  const playWithTracking = useCallback(() => {
    if (playback.isAnimatable) {
      track('Route Played', {
        boardName: boardDetails.board_name,
        layoutName: boardDetails.layout_name ?? '',
        frameCount: climbFrames.frameStrings.length,
        speed: playback.speed,
        climbUuid: activeClimbUuid,
      });
    }
    playback.play();
  }, [playback, boardDetails, climbFrames.frameStrings.length, activeClimbUuid]);

  // Stable reference so the drawer's `aboveFold` memo and the
  // `SwipeBoardCarousel` props don't bust on every render that doesn't
  // change observable playback state.
  return useMemo(
    () => ({
      isAnimatable: playback.isAnimatable,
      frameCount: climbFrames.frameStrings.length,
      currentFrameString: playback.currentFrameString,
      frameIndex: playback.frameIndex,
      isPlaying: playback.isPlaying,
      speed: playback.speed,
      play: playWithTracking,
      pause: playback.pause,
      seek: playback.seek,
      setSpeed: playback.setSpeed,
    }),
    [playback, climbFrames.frameStrings.length, playWithTracking],
  );
}
