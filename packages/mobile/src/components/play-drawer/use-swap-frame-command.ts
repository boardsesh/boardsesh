import { useLayoutEffect, type Component, type ElementType } from 'react';
import {
  dispatchCommand,
  useAnimatedReaction,
  useAnimatedRef,
  useSharedValue,
  type AnimatedRef,
  type SharedValue,
} from 'react-native-reanimated';
import type { WallSwapFrame } from './wall-swap';

/** The native view command each wall-swap frame is sent under (#7737). */
export const SWAP_FRAME_COMMAND = 'swapFrame';

/**
 * The four-number swap frame, then its sequence number. The native view drops
 * any frame whose sequence is not above the newest one it applied, so the
 * prop copy of a frame, arriving after its command, cannot step the fade back.
 */
export type SequencedSwapFrame = [
  pagePosition: number,
  outgoingWeight: number,
  incomingWeight: number,
  sharedWeight: number,
  sequence: number,
];

/**
 * Always five numbers. A binary that takes the command reads the fifth as the
 * sequence, so the frame keeps its shared weight even where the API version
 * would trim it.
 */
export function sequencedSwapFrame(frame: WallSwapFrame, sequence: number): SequencedSwapFrame {
  'worklet';
  return [frame[0], frame[1], frame[2], frame[3], sequence];
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
  swapFrame: SharedValue<WallSwapFrame> | undefined,
  enabled: boolean,
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
      const sequenced = sequencedSwapFrame(frame, next);
      latest.value = sequenced;
      if (targetMounted.value) dispatchCommand(target, SWAP_FRAME_COMMAND, sequenced);
    },
    [enabled, swapFrame],
  );
  return { target, latest };
}
