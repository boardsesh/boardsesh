import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { BoardName, Climb } from '@boardsesh/shared-schema';
import { useClimbFrames, usePlaybackEngine, type ExternalPlaybackState } from '@boardsesh/playback-react';
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
  onRoutePlayed,
}: UseMobilePlaybackInput): UseMobilePlaybackOutput {
  const { subscribeToQueueEvents, publishPlaybackState } = useQueueActions();
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
    const unsubscribe = subscribeToQueueEvents((event) => {
      if (event.__typename !== 'PlaybackStateChanged') return;
      if (event.climbUuid !== climbUuid) return;
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
  }, [climbUuid, subscribeToQueueEvents]);

  const handleLocalStateChange = useCallback(
    (next: ExternalPlaybackState) => {
      if (!climbUuid) return;
      void publishPlaybackState({
        climbUuid,
        frameIndex: next.frameIndex,
        isPlaying: next.isPlaying,
        speed: next.speed,
        paceMs: next.paceMs,
        clientId: playbackClientId,
      });
    },
    [climbUuid, publishPlaybackState, playbackClientId],
  );

  const playback = usePlaybackEngine({
    frames,
    frameStrings,
    paceMs,
    clientId: playbackClientId,
    externalState: externalPlayback,
    onLocalStateChange: handleLocalStateChange,
  });

  // --- Latest-wins BLE frame writer ---
  // Mobile's sendFramesToBoard has NO internal write mutex (web's does), so this
  // drain is the ONLY guard against overlapping GATT writes. A second write
  // issued before the first resolves throws "GATT operation already in progress"
  // on Android, so this stays a faithful port of web's use-drawer-playback drain:
  // collapse bursts to the newest frame, never overlap a write.
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
    if (!isOpen || !isAnimatable || !bluetoothConnected || !bluetooth) return;
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
  }, [isOpen, isAnimatable, bluetoothConnected, bluetooth, currentFrameString]);

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
      play,
      pause: playback.pause,
      seek: playback.seek,
      setSpeed: playback.setSpeed,
    }),
    [playback, frameStrings.length, paceMs, play],
  );
}
