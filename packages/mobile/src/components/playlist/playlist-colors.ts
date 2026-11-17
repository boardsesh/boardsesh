import { isValidPlaylistColor, normalizePlaylistColor } from '@boardsesh/shared-schema';
import { brandColors } from '@boardsesh/velvet-tokens';

// Cycling swatch palette for playlists. Used as the preview tint when a playlist
// has no valid `color`, and as the swatch options in the create/edit form. Leads
// with the violet brand + amber accent, then a varied set so playlists stay
// distinguishable. Mobile-specific (intentionally diverges from web's list, which
// keeps the old maroon-led order). Trails with two dark options (dark grey +
// near-black) for "bad climbs"-style lists; the form gives swatches a hairline
// outline so they stay visible on the dark sheet.
//
// The brand swatch reads the token, so it follows a brand retune. A playlist saved
// with an earlier brand hex keeps that hex: the colour is the climber's data.
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

export { isValidPlaylistColor, normalizePlaylistColor };
