import { WALL_SWAP } from '../../play-drawer/wall-swap';
import { lookVariant } from './look-variant';

/**
 * I: the round-2 pick (motion designer, climber and GPU reviews). E's ghosts
 * with G's standby ring on the climb being left: while dragging, the old holds
 * dim and pull their glow in from the edge the next climb comes from, and the
 * next climb shows behind that front as glow-only halos; letting go fills them
 * in along the same sweep. Direction belongs to the drag, speed to the release.
 * A flick run is calm: no ghosts, no drag dim, no swell, a 140 ms swap.
 */
export const GHOST_PEEK_STANDBY = lookVariant({
  id: 'ghost-peek-standby',
  letter: 'I',
  name: 'Ghost peek + standby',
  summary:
    'Dragging pulls the old holds into dim rings and shows the next climb as halos behind a sweeping front; letting go fills them in along the sweep.',
  defaults: {
    tuning: { ...WALL_SWAP, dimFloor: 0.4, durationMs: 220, outgoingEndMs: 120, incomingStartMs: 0 },
    look: {
      holdWindow: 0.25,
      lowWindow: 0.25,
      climbUp: false,
      jitter: 0,
      ghost: 0.35,
      markLag: 0.15,
      // perf-a11y R7a: 0.08 already fails the plateau 0.7 falloff; Bold explores 0.3.
      swell: 0.05,
      swellTail: 0.25,
      focus: 0,
      focusShape: 2,
      tighten: 0.35,
      topBoost: 0,
    },
    arrivalFloorShare: 1,
    linear: 0,
    sharedFloor: 1,
    runWindowMs: 400,
    runSwapMs: 140,
    ghostDrag: true,
    calmRuns: true,
  },
  sliders: [
    { key: 'ghost', label: 'Ghost glow (0 off)' },
    { key: 'tighten', label: 'Standby ring (leaving tighten)' },
    { key: 'markLag', label: 'Ring: mark trails glow' },
    { key: 'holdWindow', label: 'Front width (1 = no front)' },
    { key: 'lowWindow', label: 'Ghost front width' },
    { key: 'durationMs', label: 'Fill length' },
    'swell',
    'swellTail',
    'dimFloor',
    'outgoingEndMs',
    'incomingStartMs',
    'sharedFloor',
    'runWindowMs',
    'runSwapMs',
  ],
  bold: { ghost: 0.5, markLag: 0.4, swell: 0.3 },
});
