import { WALL_SWAP } from '../../play-drawer/wall-swap';
import { lookVariant } from './look-variant';

/**
 * E: D, plus while dragging the next climb shows as glow-only halos (no hold
 * marks) behind the front; a commit fills them in along the same sweep, and a
 * cancel takes them back. Source: climber 1.
 */
export const GHOST_PEEK = lookVariant({
  id: 'ghost-peek',
  letter: 'E',
  name: 'Ghost peek',
  summary:
    'Dragging shows the next climb as faint halos behind a sweeping front; letting go fills them in along the same sweep.',
  defaults: {
    tuning: { ...WALL_SWAP, durationMs: 180, outgoingEndMs: 120, incomingStartMs: 0 },
    look: {
      holdWindow: 0.25,
      lowWindow: 0.25,
      climbUp: false,
      jitter: 0,
      ghost: 0.3,
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
    ghostDrag: true,
    calmRuns: true,
  },
  sliders: [
    'ghost',
    { key: 'holdWindow', label: 'Front width (1 = no front)' },
    { key: 'lowWindow', label: 'Ghost front width' },
    { key: 'durationMs', label: 'Fill length' },
    'swell',
    'tighten',
    'swellTail',
    'dimFloor',
    'outgoingEndMs',
    'incomingStartMs',
    'linear',
    'arrivalFloorShare',
    'sharedFloor',
    'runWindowMs',
    'runSwapMs',
  ],
  // Bold: ghosts at half glow sweep in behind the finger, then fill in hold by hold.
  bold: {
    durationMs: 400,
    outgoingEndMs: 250,
    incomingStartMs: 0,
    linear: 1,
    holdWindow: 0.2,
    lowWindow: 0.2,
    arrivalFloorShare: 1,
    ghost: 0.5,
    swell: 0.25,
    swellTail: 0.2,
    tighten: 0.3,
    sharedFloor: 1,
  },
});
