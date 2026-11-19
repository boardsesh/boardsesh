import { useLayoutEffect, type Component, type ElementType } from 'react';
import {
  dispatchCommand,
  useAnimatedReaction,
  useAnimatedRef,
  useSharedValue,
  type AnimatedRef,
  type SharedValue,
} from 'react-native-reanimated';
import type { BoardSwapFrame } from './play-drawer/swap-look';
import {
  INITIAL_SWAP_FRAME_SEQUENCE,
  SWAP_FRAME_COMMAND,
  sequencedSwapFrame,
} from './play-drawer/use-swap-frame-command';

/**
 * The board's swap frame as the frost view takes it: the board's own frame
 * (four numbers, or six with the look's arrival codes) with its sequence
 * after the fourth number, or `[sequence]` alone when the board draws no
 * frames (no GPU board, the wipe, the board unmounted), which puts the frost
 * back on its own release.
 */
export function frostSwapFrame(frame: BoardSwapFrame | null, sequence: number): number[] {
  'worklet';
  return frame === null ? [sequence] : [...sequencedSwapFrame(frame, sequence)];
}

/** Before the UI thread's first frame: "no frames", below every real sequence. */
export const INITIAL_FROST_SWAP_FRAME: readonly number[] = [INITIAL_SWAP_FRAME_SEQUENCE];

export type FrostSwapFrameCommand<Target extends Component | ElementType> = {
  /** Attach to the animated native frost view: the command's target. */
  target: AnimatedRef<Target>;
  /** The frame for the animated prop (mount and the first frame only); null until the UI thread sent one. */
  latest: SharedValue<number[] | null>;
};

/**
 * Sends each of the board's swap frames to the frost view as the `swapFrame`
 * view command from the UI thread, as `useSwapFrameCommand` does for the board
 * overlay, so a React commit never holds a frame back. Nothing crosses to the
 * JS thread. The sequence lives with the frost view, so a new frame source
 * (the board remounting) never sends a frame the view would take as old.
 *
 * Pass `enabled` only for a binary with `swapFrameApi`: an older one drops the
 * command without a word.
 */
export function useFrostSwapFrame<Target extends Component | ElementType>(
  frames: SharedValue<BoardSwapFrame | null> | undefined,
  enabled: boolean,
): FrostSwapFrameCommand<Target> {
  const target = useAnimatedRef<Target>();
  const targetMounted = useSharedValue(false);
  const sequence = useSharedValue(INITIAL_SWAP_FRAME_SEQUENCE);
  const latest = useSharedValue<number[] | null>(null);
  useLayoutEffect(() => {
    targetMounted.value = true;
    return () => {
      // Android logs a soft exception for every command sent to a removed view.
      targetMounted.value = false;
    };
  }, [targetMounted]);
  useAnimatedReaction(
    // Undefined: nothing to send. Null is a frame too: "no frames".
    () => (enabled && frames ? frames.value : undefined),
    (frame) => {
      if (frame === undefined) return;
      const next = sequence.value + 1;
      sequence.value = next;
      const sequenced = frostSwapFrame(frame, next);
      // The animated prop is a Fabric commit: write it only for mount (no
      // target yet) and for the first frame, never per frame. The command
      // carries the rest, and a view mounted later takes the stale copy only
      // until the next command, which the sequence lets through.
      if (!targetMounted.value || latest.value === null) latest.value = sequenced;
      if (targetMounted.value) dispatchCommand(target, SWAP_FRAME_COMMAND, sequenced);
    },
    [enabled, frames],
  );
  return { target, latest };
}
