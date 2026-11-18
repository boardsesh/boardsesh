import { WALL_SWAP } from '../../play-drawer/wall-swap';
import { lookVariant } from './look-variant';

/**
 * G: dragging drops the old holds to standby one by one (dim hold, tight ring
 * of glow); after the commit the new holds strike on fast in a slightly ragged
 * run across the wall, each with a small flare. Shared holds barely blink, and
 * not at all in a flick run. Source: GPU B, with its flare and flash at
 * flash-safe defaults (1.08×, no extra glow).
 */
export const LED_STRIKE = lookVariant({
  id: 'led-strike',
  letter: 'G',
  name: 'LED strike',
  summary:
    'Dragging drops the old holds to standby rings one by one; the new holds then strike on fast in a ragged run across the wall, each with a small flare.',
  defaults: {
    tuning: { ...WALL_SWAP, durationMs: 300, outgoingEndMs: 120, incomingStartMs: 60 },
    look: {
      holdWindow: 0.12,
      lowWindow: 1,
      climbUp: false,
      jitter: 0.25,
      ghost: 0,
      markLag: 0.6,
      swell: 0.08,
      swellTail: 0.35,
      focus: 0,
      focusShape: 2,
      tighten: 0.5,
      topBoost: 0,
    },
    arrivalFloorShare: 1,
    linear: 0,
    sharedFloor: 0.8,
    runWindowMs: 350,
    runSwapMs: 0,
    ghostDrag: false,
    calmRuns: false,
  },
  sliders: [
    { key: 'durationMs', label: 'Sweep' },
    { key: 'holdWindow', label: 'Strike window' },
    'jitter',
    { key: 'swell', label: 'Flare' },
    { key: 'swellTail', label: 'Flare settle' },
    { key: 'markLag', label: 'Afterglow' },
    { key: 'tighten', label: 'Standby ring' },
    'dimFloor',
    'outgoingEndMs',
    'incomingStartMs',
    'linear',
    'lowWindow',
    'arrivalFloorShare',
    'sharedFloor',
    'runWindowMs',
    'runSwapMs',
  ],
  // Bold: a dark standby while dragging, then 24 ms strikes in a ragged run, each flaring to 1.35×.
  bold: {
    dimFloor: 0.25,
    durationMs: 360,
    outgoingEndMs: 120,
    incomingStartMs: 60,
    linear: 1,
    holdWindow: 0.08,
    lowWindow: 1,
    arrivalFloorShare: 0,
    jitter: 0.45,
    markLag: 0.8,
    swell: 0.35,
    swellTail: 0.2,
    tighten: 0.5,
    sharedFloor: 0.6,
  },
});
