import type { IconName } from './icon-map';
import type { AscentStatusValue } from '../lib/ascent-status-utils';

/**
 * Scan-line status marker. Status is carried by glyph SHAPE in a single neutral
 * colour — not a hue — so it can't be mistaken for the colour-coded grade beside
 * it, and so it stays readable for colour-blind users. ⚡ flashed, ✓ sent,
 * ✗ attempted.
 *
 * Lives in its own module because two components now draw it — the trailing
 * `AscentStatusGlyph` and the rich tier's leading `ClimbProgressLine` glyph — and
 * `ClimbListItemContent` imports the latter, so keeping the map there would make
 * the pair a cycle.
 */
export const ASCENT_STATUS_ICON: Record<AscentStatusValue, IconName> = {
  flash: 'flash',
  send: 'tick.outline',
  attempt: 'ascent.attempt',
};
