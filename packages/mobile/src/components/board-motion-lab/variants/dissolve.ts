import { WALL_SWAP, WALL_SWAP_NATIVE_API, wallSwapDriver, type WallSwapInput } from '../../play-drawer/wall-swap';
import type {
  BoardTransitionDriver,
  BoardTransitionState,
  BoardTransitionStep,
} from '../../play-drawer/board-transition';
import type { BoardMotionVariant } from '../types';
import { paramOr } from './tuning-params';

/**
 * `driver` as it runs under Reduce Motion, whatever the system or the lab's
 * Reduce Motion control says: no dim while dragging, one dissolve the length of
 * `reduceMotionDurationMs`, shared holds whole throughout.
 */
function underReduceMotion(driver: BoardTransitionDriver): BoardTransitionDriver {
  const rest = (input: WallSwapInput): BoardTransitionState => {
    'worklet';
    return driver.rest({ ...input, reduceMotion: true });
  };
  const step = (previous: BoardTransitionState, input: WallSwapInput): BoardTransitionStep => {
    'worklet';
    return driver.step(previous, { ...input, reduceMotion: true });
  };
  return { rest, step };
}

/** C: the Reduce Motion swap as everyone's: one fade, no dim while dragging, shared holds steady. */
export const DISSOLVE: BoardMotionVariant = {
  id: 'dissolve',
  letter: 'C',
  name: 'Dissolve',
  summary: 'Nothing moves while dragging; a commit fades the old holds out and the new ones in, shared holds steady.',
  params: [
    {
      key: 'durationMs',
      label: 'Dissolve',
      min: 40,
      max: 600,
      step: 10,
      default: WALL_SWAP.reduceMotionDurationMs,
      unit: 'ms',
    },
  ],
  createTransition: (params) => ({
    revealMode: 'swap',
    driver: underReduceMotion(
      wallSwapDriver({
        ...WALL_SWAP,
        reduceMotionDurationMs: paramOr(params, 'durationMs', WALL_SWAP.reduceMotionDurationMs),
      }),
    ),
  }),
  requiresNativeApi: WALL_SWAP_NATIVE_API,
};
