/**
 * Portrait dimensions of the shared climb-list thumbnail cell, and the geometry
 * of the selectable climbs-list density tiers.
 *
 * Kept separate from `ClimbListThumbnail` so list-adjacent components can align
 * placeholders and separators without importing the native image renderer.
 */
import { spacing } from '../theme/tokens';

export const THUMBNAIL_WIDTH = 76;
export const THUMBNAIL_HEIGHT = 96;

/**
 * How much of a climb the climbs list shows per row. A user setting
 * (Avatar → Settings → Climb list), read ONLY by the climbs list — every other surface that
 * renders a `ClimbListRow` (playlist detail, profile climbs, the two board-presence
 * lists) stays on `default`.
 *
 * - `compact` — 56×72 thumbnail, name + attribute glyphs + grade. No subtitle, no
 *   playlist tags. ~88pt row.
 * - `default` — today's row, byte-for-byte: 76×96 thumbnail, name row + the
 *   `sends · ★ · setter` subtitle. 112pt row.
 * - `rich` — `default` plus the playlist tags under the subtitle. Still 112pt.
 */
export type ClimbListDensity = 'compact' | 'default' | 'rich';

/**
 * Compact uses a smaller cell so its thumbnail no longer keeps the row at the
 * standard height. Every tier stays within the existing 76pt width.
 * ClimbListThumbnail requests Math.max(400, Math.round(cellWidth * 5)), so both
 * supported widths keep the same 400px render request. LayeredClimbImage uses
 * memory caching; density does not add a larger native render variant.
 */
export const COMPACT_THUMBNAIL_WIDTH = 56;
export const COMPACT_THUMBNAIL_HEIGHT = 72;

/** The thumbnail cell for a density tier. `default` and `rich` share the 76×96 cell. */
export function thumbnailSizeForDensity(density: ClimbListDensity): { width: number; height: number } {
  return density === 'compact'
    ? { width: COMPACT_THUMBNAIL_WIDTH, height: COMPACT_THUMBNAIL_HEIGHT }
    : { width: THUMBNAIL_WIDTH, height: THUMBNAIL_HEIGHT };
}

/**
 * Left inset of the row separator, so it starts at the text column rather than the
 * screen edge. Derived from the tier's own thumbnail width — the compact row must
 * not carry a second hardcoded inset that silently drifts from its cell.
 */
export function separatorInsetForDensity(density: ClimbListDensity): number {
  return thumbnailSizeForDensity(density).width + spacing[2] + spacing[3];
}
