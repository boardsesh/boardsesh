import { isValidPlaylistColor, normalizePlaylistColor as normalizeSavedPlaylistColor } from '@boardsesh/shared-schema';
import { brandColors, currentBrandColor } from '@boardsesh/velvet-tokens';

// Cycling swatch palette for playlists. Used as the preview tint when a playlist
// has no valid `color`, and as the swatch options in the create/edit form. Leads
// with the violet brand + mint spark, then a varied set so playlists stay
// distinguishable. Mobile-specific (intentionally diverges from web's list, which
// keeps the old maroon-led order). Trails with two dark options (dark grey +
// near-black) for "bad climbs"-style lists; the form gives swatches a hairline
// outline so they stay visible on the dark sheet.
//
// The brand swatches read the tokens, so they follow a brand retune.
export const PLAYLIST_COLORS = [
  brandColors.primaryFill, // brand violet (white text reads on it in both schemes)
  brandColors.accent, // mint spark (follows the token)
  '#047857', // emerald
  '#2563EB', // blue
  '#DB2777', // pink
  '#0891B2', // cyan
  '#CA8A04', // gold
  '#DC2626', // red
  '#374151', // dark grey
  '#1F2937', // near-black
] as const;

/**
 * A saved playlist colour in canonical `#RRGGBB`, or `null` when it isn't one. A
 * colour saved from a retired brand swatch (the old violet #6D28D9, the amber spark
 * #FF8A3D) reads as today's brand token, so an old playlist matches the current
 * swatch, the form shows that swatch as picked, and the next save writes it.
 * Every playlist colour reader in the app goes through this, not the shared-schema
 * normaliser directly.
 */
export function normalizePlaylistColor(color: string | null | undefined): string | null {
  const normalized = normalizeSavedPlaylistColor(color);
  return normalized === null ? null : currentBrandColor(normalized);
}

export { isValidPlaylistColor };
