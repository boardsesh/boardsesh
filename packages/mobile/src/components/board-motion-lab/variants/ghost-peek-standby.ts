import { PLAYER_SWAP_LOOK } from '../../play-drawer/player-swap-look';
import { lookVariant } from './look-variant';

/**
 * I: the round-2 pick (motion designer, climber and GPU reviews), and since
 * 2026-11-18 the player's look on iOS and Android. E's ghosts with G's standby ring on the
 * climb being left: while dragging, the old holds dim and pull their glow in
 * from the edge the next climb comes from, and the next climb shows behind that
 * front as glow-only halos; letting go fills them in along the same sweep.
 * Direction belongs to the drag, speed to the release. A flick run is calm: no
 * ghosts, no drag dim, no swell, a 140 ms swap.
 *
 * Its Subtle preset is the player's own numbers (`PLAYER_SWAP_LOOK`): change
 * them there, and the lab and the player change together.
 */
export const GHOST_PEEK_STANDBY = lookVariant({
  id: 'ghost-peek-standby',
  letter: 'I',
  name: 'Ghost peek + standby',
  summary:
    'Dragging pulls the old holds into dim rings and shows the next climb as halos behind a sweeping front; letting go fills them in along the sweep.',
  defaults: { ...PLAYER_SWAP_LOOK, linear: 0 },
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
