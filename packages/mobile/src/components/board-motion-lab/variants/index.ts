/**
 * Every transition the lab can show, in the order they are lettered. Adding a
 * design idea is one file here and one line below; see docs/board-motion-lab.md.
 */
import type { BoardMotionVariant } from '../types';
import { DISSOLVE } from './dissolve';
import { SHIPPED_WALL_SWAP } from './shipped-wall-swap';
import { WIPE } from './wipe';

export const BOARD_MOTION_VARIANTS: readonly BoardMotionVariant[] = [SHIPPED_WALL_SWAP, WIPE, DISSOLVE];
