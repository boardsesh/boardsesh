/**
 * Every transition the lab can show, in the order they are lettered. Adding a
 * design idea is one file here and one line below; see docs/board-motion-lab.md.
 */
import type { BoardMotionVariant } from '../types';
import { CLIMB_UP } from './climb-up';
import { DISSOLVE } from './dissolve';
import { FOCUS_IN } from './focus-in';
import { GHOST_PEEK } from './ghost-peek';
import { LED_STRIKE } from './led-strike';
import { SHIPPED_WALL_SWAP } from './shipped-wall-swap';
import { SIDEWAYS_CASCADE } from './sideways-cascade';
import { WIPE } from './wipe';

export const BOARD_MOTION_VARIANTS: readonly BoardMotionVariant[] = [
  SHIPPED_WALL_SWAP,
  WIPE,
  DISSOLVE,
  SIDEWAYS_CASCADE,
  GHOST_PEEK,
  CLIMB_UP,
  LED_STRIKE,
  FOCUS_IN,
];
