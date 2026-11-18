import { WALL_SWAP } from '../../play-drawer/wall-swap';
import { LINEAR, lookVariant } from './look-variant';

/**
 * J: the perf/accessibility pick (round 2), G re-tuned to pass R1-R8 on paper.
 * Dragging drops the old holds to a dim, tight standby ring one by one from the
 * edge the next climb comes from; after the commit the rings go out by 40 ms,
 * the new climb shows as standby rings, then its holds strike to full one by
 * one across the wall (about 21 ms each, a 1.05× flare, slightly ragged).
 */
export const SIDEWAYS_STRIKE = lookVariant({
  id: 'sideways-strike',
  letter: 'J',
  name: 'Sideways strike',
  summary:
    'Dragging drops the old holds to dim standby rings from the side the next climb enters; after the commit the new holds strike on one by one across the wall.',
  defaults: {
    tuning: {
      ...WALL_SWAP,
      dimFloor: 0.2,
      durationMs: 280,
      outgoingEndMs: 40,
      incomingStartMs: 65,
      easeIn: LINEAR,
      easeOut: LINEAR,
    },
    look: {
      holdWindow: 0.15,
      lowWindow: 1,
      climbUp: false,
      jitter: 0.15,
      ghost: 0,
      markLag: 0,
      swell: 0.05,
      swellTail: 0.2,
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
    { key: 'holdWindow', label: 'Strike window' },
    'jitter',
    { key: 'swell', label: 'Flare' },
    { key: 'swellTail', label: 'Flare settle' },
    { key: 'tighten', label: 'Standby ring' },
    'dimFloor',
    { key: 'durationMs', label: 'Sweep' },
    'outgoingEndMs',
    'incomingStartMs',
    'sharedFloor',
    'runWindowMs',
    'runSwapMs',
  ],
  bold: { swell: 0.2, jitter: 0.3, tighten: 0.7 },
});
