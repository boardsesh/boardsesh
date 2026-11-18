import { WALL_SWAP_NATIVE_API, wallSwapDriver } from '../../play-drawer/wall-swap';
import type { BoardMotionVariant } from '../types';
import { WALL_SWAP_PARAMS, tuningFromParams } from './tuning-params';

/**
 * A: the swap the player ships (#7725, #7740, #7750), every number on a slider.
 * Needs the native swap (API 6); shared holds dip with the rest only on API 7
 * binaries, as in the player (`nativeWallSwapFrame`).
 */
export const SHIPPED_WALL_SWAP: BoardMotionVariant = {
  id: 'shipped-wall-swap',
  letter: 'A',
  name: 'Shipped wall swap',
  summary:
    'Dragging dims the holds that leave; a commit fades them out and the new ones in, shared holds dipping with them.',
  params: WALL_SWAP_PARAMS,
  createTransition: (params) => ({ revealMode: 'swap', driver: wallSwapDriver(tuningFromParams(params)) }),
  requiresNativeApi: WALL_SWAP_NATIVE_API,
};
