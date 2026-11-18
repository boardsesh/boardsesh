import { WALL_SWAP } from '../../play-drawer/wall-swap';
import { lookVariant } from './look-variant';

/**
 * D: the dim front follows the finger in from the edge the next climb enters
 * from; after the commit the new holds light one by one across the wall, each
 * glow swelling a little (1.08×, inside the flash budget) as it lands. Shared
 * holds stay whole. Sources: motion designer A, perf P1, GPU A.
 */
export const SIDEWAYS_CASCADE = lookVariant({
  id: 'sideways-cascade',
  letter: 'D',
  name: 'Sideways cascade',
  summary:
    'The dim follows the finger in from the side the next climb enters; the new holds then light one by one across the wall, each glow swelling slightly.',
  defaults: {
    tuning: { ...WALL_SWAP, durationMs: 260, outgoingEndMs: 110, incomingStartMs: 40 },
    look: {
      holdWindow: 0.4,
      lowWindow: 1,
      climbUp: false,
      jitter: 0,
      ghost: 0,
      markLag: 0,
      swell: 0.08,
      swellTail: 0.25,
      focus: 0,
      focusShape: 2,
      tighten: 0.15,
      topBoost: 0,
    },
    arrivalFloorShare: 1,
    linear: 0,
    sharedFloor: 1,
    runWindowMs: 350,
    runSwapMs: 0,
    ghostDrag: false,
    calmRuns: false,
  },
  sliders: [
    'holdWindow',
    'swell',
    'swellTail',
    'tighten',
    'dimFloor',
    'durationMs',
    'outgoingEndMs',
    'incomingStartMs',
    'lowWindow',
    'linear',
    'arrivalFloorShare',
    'sharedFloor',
    'runWindowMs',
    'runSwapMs',
  ],
  // Bold: one front from the entry edge, old holds going out and new ones coming
  // in hold by hold at an even pace, a 1.3× swell, shared holds dipping as it passes.
  bold: {
    durationMs: 420,
    outgoingEndMs: 260,
    incomingStartMs: 60,
    linear: 1,
    holdWindow: 0.2,
    lowWindow: 0.2,
    arrivalFloorShare: 0,
    swell: 0.3,
    swellTail: 0.2,
    tighten: 0.35,
    sharedFloor: 0.4,
  },
});
