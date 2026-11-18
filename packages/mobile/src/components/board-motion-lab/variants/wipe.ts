import { MOTION_NATIVE_API } from '../stage-status';
import type { BoardMotionVariant } from '../types';

/** B: the reveal before #7725: the new climb's holds wipe in across the wall as the board travels. */
export const WIPE: BoardMotionVariant = {
  id: 'wipe',
  letter: 'B',
  name: 'Wipe',
  summary: "The next climb's holds sweep in across the wall with the finger, the old ones out ahead of them.",
  params: [],
  createTransition: () => ({ revealMode: 'wipe' }),
  requiresNativeApi: MOTION_NATIVE_API,
};
