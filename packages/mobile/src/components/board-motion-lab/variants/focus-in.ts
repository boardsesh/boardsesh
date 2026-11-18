import { WALL_SWAP } from '../../play-drawer/wall-swap';
import { LINEAR, lookVariant } from './look-variant';

/**
 * H: no sweep. The new holds arrive as wide, soft glow that pulls tight onto
 * them as they brighten (reach 1.3 → 1, inside the flash budget because the
 * glow is faint while it is wide); the old holds' glow pulls in as they fade.
 * Source: perf P2.
 */
export const FOCUS_IN = lookVariant({
  id: 'focus-in',
  letter: 'H',
  name: 'Focus in',
  summary:
    'No sweep: the new holds arrive as wide, soft glow that tightens onto them; the old glow pulls in as it fades.',
  defaults: {
    tuning: { ...WALL_SWAP, dimFloor: 0.5, durationMs: 240, outgoingEndMs: 140, incomingStartMs: 40, easeIn: LINEAR },
    look: {
      holdWindow: 1,
      lowWindow: 1,
      climbUp: false,
      jitter: 0,
      ghost: 0,
      markLag: 0,
      swell: 0,
      swellTail: 0,
      focus: 0.3,
      focusShape: 2,
      tighten: 0.3,
      topBoost: 0,
    },
    arrivalFloorShare: 1,
    linear: 0,
    sharedFloor: 0.7,
    runWindowMs: 350,
    runSwapMs: 0,
    ghostDrag: false,
    calmRuns: false,
  },
  sliders: [
    'focus',
    { key: 'tighten', label: 'Outgoing contraction' },
    { key: 'durationMs', label: 'Incoming ends at' },
    'incomingStartMs',
    'outgoingEndMs',
    'dimFloor',
    'focusShape',
    'linear',
    'sharedFloor',
    'runWindowMs',
    'runSwapMs',
  ],
  // Bold: the new glow arrives at 1.35× and stays wide until its hold is nearly lit; the old pulls in to 0.6×.
  bold: {
    dimFloor: 0.5,
    durationMs: 360,
    outgoingEndMs: 200,
    incomingStartMs: 40,
    linear: 1,
    focus: 0.35,
    focusShape: 0.5,
    tighten: 0.4,
    sharedFloor: 0.7,
  },
});
