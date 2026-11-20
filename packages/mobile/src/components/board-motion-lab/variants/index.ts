/**
 * Every transition the lab can show, in the order the lab lists them. Adding a
 * design idea is one file here and one line below; see docs/rendering/board-motion-lab.md.
 * I, the round-2 pick, comes first among the swap looks and opens by default.
 */
import type { BoardMotionVariant } from '../types';
import { CLIMB_UP } from './climb-up';
import { DISSOLVE } from './dissolve';
import { FOCUS_IN } from './focus-in';
import { GHOST_PEEK } from './ghost-peek';
import { GHOST_PEEK_STANDBY } from './ghost-peek-standby';
import { LED_STRIKE } from './led-strike';
import { SHIPPED_WALL_SWAP } from './shipped-wall-swap';
import { SIDEWAYS_CASCADE } from './sideways-cascade';
import { SIDEWAYS_STRIKE } from './sideways-strike';
import { WIPE } from './wipe';

export const BOARD_MOTION_VARIANTS: readonly BoardMotionVariant[] = [
  SHIPPED_WALL_SWAP,
  WIPE,
  DISSOLVE,
  GHOST_PEEK_STANDBY,
  SIDEWAYS_STRIKE,
  SIDEWAYS_CASCADE,
  GHOST_PEEK,
  CLIMB_UP,
  LED_STRIKE,
  FOCUS_IN,
];

/** The variant the lab opens on when the binary can run it. */
export const DEFAULT_VARIANT_ID = GHOST_PEEK_STANDBY.id;
