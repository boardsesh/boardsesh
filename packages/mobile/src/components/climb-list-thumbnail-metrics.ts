/**
 * Portrait dimensions of the shared climb-list thumbnail cell, and the geometry
 * of the selectable climbs-list density tiers.
 *
 * Kept separate from `ClimbListThumbnail` so list-adjacent components can align
 * placeholders and separators without importing the native image renderer.
 */
export const THUMBNAIL_WIDTH = 76;
export const THUMBNAIL_HEIGHT = 96;

/**
 * How much of a climb the climbs list shows per row. A user setting
 * (More → Climb list), read ONLY by the climbs list — every other surface that
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
 * Compact thumbnail cell. SMALLER than the default on purpose, and no tier in the
 * app renders one LARGER.
 *
 * The thumbnail pins the row height (76×96 plus 8pt of vertical padding IS the
 * 112pt row), so a compact tier that only drops text lines would save nothing — it
 * has to shrink the cell. Shrinking is free: `ClimbListThumbnail` renders at
 * `Math.max(400, cellWidth * 5)`, so a 56pt cell resolves to the SAME 400px render
 * as the 76pt cell — byte-identical, no new cache generation. Growing it is not
 * free: a 132pt cell would ask for 660px and mint a second generation in both the
 * native render cache and expo-image's disk cache, on the app's largest memory
 * consumer (docs/react-native-performance.md §7 — foreground OOM kills on 4 GB
 * iPhones, #3479). So a richer tier adds LINES, never pixels.
 */
export const COMPACT_THUMBNAIL_WIDTH = 56;
export const COMPACT_THUMBNAIL_HEIGHT = 72;

/** Row padding + thumbnail-to-text gap, mirroring `climbListRowStyles.contentRow`. */
const ROW_HORIZONTAL_PADDING = 8;
const ROW_COLUMN_GAP = 12;

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
  return thumbnailSizeForDensity(density).width + ROW_HORIZONTAL_PADDING + ROW_COLUMN_GAP;
}
