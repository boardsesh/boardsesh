import { useLayoutEffect, type Component, type ElementType } from 'react';
import {
  dispatchCommand,
  useAnimatedReaction,
  useAnimatedRef,
  useSharedValue,
  type AnimatedRef,
  type SharedValue,
} from 'react-native-reanimated';
import { shippedSwapFrame, type BoardSwapFrame, type SwapFrameSource } from './swap-look';

/** The native view command each wall-swap frame is sent under (#7737). */
export const SWAP_FRAME_COMMAND = 'swapFrame';

/**
 * The four-number swap frame, then its sequence number. The native view drops
 * any frame whose sequence is not above the newest one it applied, so the
 * prop copy of a frame, arriving after its command, cannot step the fade back.
 * A swap-look frame (`swap-look.ts`) carries its two arrival flags after the
 * sequence: seven numbers, which only a binary with `swapLookVersion` takes.
 */
export type SequencedSwapFrame =
  | [pagePosition: number, outgoingWeight: number, incomingWeight: number, sharedWeight: number, sequence: number]
  | [
      pagePosition: number,
      outgoingWeight: number,
      incomingWeight: number,
      sharedFloor: number,
      sequence: number,
      outgoingArrives: number,
      incomingArrives: number,
    ];

/**
 * Five numbers, or seven for a swap-look frame. A binary that takes the
 * command reads the fifth as the sequence, so the frame keeps its shared weight
 * even where the API version would trim it.
 */
export function sequencedSwapFrame(frame: BoardSwapFrame, sequence: number): SequencedSwapFrame {
  'worklet';
  if (frame.length === 4) return [frame[0], frame[1], frame[2], frame[3], sequence];
  return [frame[0], frame[1], frame[2], frame[3], sequence, frame[4], frame[5]];
}

/** The sequence of the frame JS sends before the first UI-thread frame: below every real one. */
export const INITIAL_SWAP_FRAME_SEQUENCE = 0;

export type SwapFrameCommand<Target extends Component | ElementType> = {
  /** Attach to the animated native overlay: the command's target. */
  target: AnimatedRef<Target>;
  /** The newest sequenced frame, for the animated prop; null until the UI thread produced one. */
  latest: SharedValue<SequencedSwapFrame | null>;
};

/**
 * Sends each wall-swap frame to the native overlay as a view command from the
 * UI thread. An animated prop is a shadow-tree commit, which Reanimated holds
 * back while a React commit is mounting; a command skips the commit, so a
 * re-render during the fade no longer freezes it and then jumps (#7737).
 *
 * Only pass `enabled` when the native module advertises `swapCommandApi`:
 * an older binary drops the command without a word. The caller keeps sending
 * `latest` as the animated prop; the view applies that on mount and ignores
 * it whenever the command already delivered the frame.
 */
export function useSwapFrameCommand<Target extends Component | ElementType>(
  swapFrame: SwapFrameSource | undefined,
  enabled: boolean,
  /** The binary draws the swap look: send look frames whole. Otherwise they go as the shipped four numbers. */
  look = false,
): SwapFrameCommand<Target> {
  const target = useAnimatedRef<Target>();
  const targetMounted = useSharedValue(false);
  const sequence = useSharedValue(INITIAL_SWAP_FRAME_SEQUENCE);
  const latest = useSharedValue<SequencedSwapFrame | null>(null);
  useLayoutEffect(() => {
    targetMounted.value = true;
    return () => {
      // Android logs a soft exception for every command sent to a removed view.
      targetMounted.value = false;
    };
  }, [targetMounted]);
  useAnimatedReaction(
    () => (enabled && swapFrame ? swapFrame.value : null),
    (frame) => {
      if (frame === null) return;
      const next = sequence.value + 1;
      sequence.value = next;
      const sequenced = sequencedSwapFrame(look ? frame : shippedSwapFrame(frame), next);
      latest.value = sequenced;
      if (targetMounted.value) dispatchCommand(target, SWAP_FRAME_COMMAND, sequenced);
    },
    [enabled, swapFrame, look],
  );
  return { target, latest };
}
