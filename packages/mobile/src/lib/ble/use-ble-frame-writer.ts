import { useEffect, useRef } from 'react';
import type { SendFramesToBoard } from './use-board-bluetooth';

type UseBleFrameWriterInput = {
  /**
   * The flat, single-frame BLE string to put on the wall, or `null` for "don't
   * write" — paused, view-only, disconnected, or a surface that isn't driving
   * the wall right now.
   */
  frame: string | null;
  send: SendFramesToBoard | undefined;
  mirrored: boolean;
  /**
   * Resets the dedup so the next frame always flushes. Change it whenever the
   * thing being played changes identity (a new climb, a new draft).
   */
  resetKey: string | null;
  /**
   * Called once per write ATTEMPT, immediately before the frame is handed to the
   * transport — so it also fires for a write that then throws. That is
   * deliberate: it tells the Bluetooth provider's wall-state dedup that its
   * record of what the wall physically shows is no longer trustworthy, and after
   * a failed write it genuinely isn't.
   */
  onWrite?: () => void;
};

/**
 * Latest-wins BLE frame writer, shared by the play drawer's route playback and
 * the create drawer's route preview.
 *
 * `sendFramesToBoard` serialises writes across all callers (its write-chain
 * mutex, mirroring web's), so overlapping calls can no longer interleave at the
 * GATT boundary. This drain still matters for a different reason: it collapses
 * animation-frame bursts to the newest frame instead of queueing every
 * intermediate frame behind the mutex, which would let the wall lag arbitrarily
 * far behind the on-screen playback.
 */
export function useBleFrameWriter({ frame, send, mirrored, resetKey, onWrite }: UseBleFrameWriterInput): void {
  const isWritingFrameRef = useRef(false);
  const pendingFrameRef = useRef<string | null>(null);
  const lastSentFrameRef = useRef<string | null>(null);
  const mirroredRef = useRef(mirrored);
  mirroredRef.current = mirrored;
  const onWriteRef = useRef(onWrite);
  onWriteRef.current = onWrite;

  // Reset the write trackers on identity change so the new thing's first frame
  // always flushes.
  useEffect(() => {
    lastSentFrameRef.current = null;
    pendingFrameRef.current = null;
  }, [resetKey]);

  useEffect(() => {
    // `frame === null`, not falsy: '' is a REAL frame — a route frame whose every
    // hold has been erased — and its clear packet has to reach the wall, or the
    // previous frame stays lit through it.
    if (!send || frame === null) {
      // Standing down — this surface is no longer driving the wall (the creator
      // handed it to the queue, playback paused, the drawer closed). Drop any
      // frame queued behind an in-flight write: without this the drain wakes when
      // that write resolves, finds the stale pending frame, and writes it AFTER
      // whoever took the wall over has already written it. On slow boxes (v2
      // with-response, MoonBoard) a write in flight plus a queued tick is the
      // common state at the 750ms pace, so the wall would light the whole route
      // and then flip back to a stale single frame — under an "On the wall" chip,
      // after presence was told the climb is lit. The in-flight write itself is
      // fine: it precedes the new owner's write in the shared mutex.
      pendingFrameRef.current = null;
      return;
    }
    if (frame === lastSentFrameRef.current) return;
    if (isWritingFrameRef.current) {
      pendingFrameRef.current = frame;
      return;
    }
    isWritingFrameRef.current = true;
    // A `send` change mid-drain (adapter swap on reconnect) leaves the old drain
    // running against the old function while this effect starts a fresh one. The
    // shared write mutex serialises them, but the old drain holds
    // `isWritingFrameRef` until it exits, so the new one queues its first frame
    // instead of flushing it — one tick late, then self-healing. Carried over
    // unchanged from `use-mobile-playback`; not worth a generation counter.
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
            onWriteRef.current?.();
            await send(next, mirroredRef.current);
          } catch (error) {
            // Best-effort: a dropped frame self-heals on the next tick. Dev-log
            // only (mobile has no analytics transport for a 'BLE Frame Send
            // Failed' event yet).
            if (__DEV__) console.warn('[ble-frame-writer] BLE frame send failed', error);
          }
          toSend = pendingFrameRef.current;
          pendingFrameRef.current = null;
        }
      } finally {
        isWritingFrameRef.current = false;
      }
    };
    void drain();
    // `resetKey` is a dep so a reset genuinely re-flushes: the reset effect above
    // runs first (declaration order), clearing the dedup, and this one then
    // re-sends even when the frame string itself is unchanged.
  }, [frame, send, resetKey]);
}
