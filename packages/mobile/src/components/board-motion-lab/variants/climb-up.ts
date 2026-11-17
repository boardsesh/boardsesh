import { WALL_SWAP } from '../../play-drawer/wall-swap';
import { lookVariant } from './look-variant';

/**
 * F: the old climb leaves sideways with the finger; the new one lights from
 * its lowest holds to its highest within its own lit holds, so the finish
 * lands last, and the top swells most. Sources: motion designer C, climber 2,
 * GPU C. Role isn't in the descriptor yet, so "finish" is the highest hold.
 */
export const CLIMB_UP = lookVariant({
  id: 'climb-up',
  letter: 'F',
  name: 'Climb-up',
  summary:
    'The old climb leaves sideways with the finger; the new one lights bottom to top, finish last, its top holds swelling most.',
  defaults: {
    tuning: { ...WALL_SWAP, durationMs: 280, outgoingEndMs: 120, incomingStartMs: 50 },
    look: {
      holdWindow: 0.35,
      lowWindow: 1,
      climbUp: true,
      jitter: 0,
      ghost: 0,
      markLag: 0,
      swell: 0.08,
      swellTail: 0.3,
      focus: 0,
      tighten: 0.15,
      topBoost: 0.6,
    },
    sharedFloor: 1,
    runWindowMs: 350,
    runSwapMs: 0,
    ghostDrag: false,
  },
  sliders: [
    { key: 'durationMs', label: 'Build length' },
    'holdWindow',
    { key: 'swell', label: 'Top swell' },
    'topBoost',
    'swellTail',
    'climbUp',
    'tighten',
    'dimFloor',
    'incomingStartMs',
    'sharedFloor',
    'runWindowMs',
    'runSwapMs',
  ],
});
