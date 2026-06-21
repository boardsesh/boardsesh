export function isNoMatchClimb(description: string | null | undefined): boolean {
  return /^no match/i.test(description || '');
}

/** Canonical marker prepended to a description to flag a "no match" climb. */
const NO_MATCH_PREFIX = 'No match\n';

/**
 * Toggle the "no match" marker on a climb description. Aurora encodes the
 * no-match rule as a description that starts with "no match" (see
 * {@link isNoMatchClimb}). Enabling prepends a canonical marker when one isn't
 * already present; disabling strips a leading no-match line. A real
 * `is_no_match` column is the proper long-term home — this keeps the convention
 * in one place until that lands.
 */
export function withNoMatch(description: string | null | undefined, enabled: boolean): string {
  const current = description ?? '';
  if (enabled) {
    return isNoMatchClimb(current) ? current : `${NO_MATCH_PREFIX}${current}`;
  }
  // Only strip our own canonical marker — "no match" as the entire first line
  // (optionally followed by a newline). Arbitrary user prose that merely starts
  // with "no match…" (e.g. "No matching feet allowed") is left intact so
  // toggling off can never delete a real description. A real is_no_match column
  // is the proper fix.
  return current.replace(/^no match(?:\r?\n|$)/i, '');
}

/**
 * Convert an Aurora quality rating (1-3) to a Boardsesh quality rating (1-5).
 *
 * Aurora's Kilter/Tension logbook stores user star ratings on a 1-3 scale
 * (0 means "unrated" and maps to null). Boardsesh stores them on a 1-5 scale.
 * We map endpoints exactly (1->1, 3->5) with 2->3 in the middle via linear
 * interpolation, and clamp defensively in case Aurora ever returns values
 * outside 1-3.
 */
export function convertQuality(auroraQuality: number | null | undefined): number | null {
  if (auroraQuality == null) return null;
  const q = Number(auroraQuality);
  if (!Number.isFinite(q) || q <= 0) return null;
  const clamped = Math.min(3, Math.max(1, q));
  return Math.round(((clamped - 1) / 2) * 4) + 1;
}

/**
 * Scale a 1-3 quality *average* onto the 1-5 scale Kilter Grips / MoonBoard
 * use, so board_climb_stats.quality_average is one scale the UI renders the
 * same way for every board. Linear ×5/3, kept continuous — unlike
 * convertQuality (which rounds a single rating to integer star steps) this
 * operates on a stored average, so rounding would lose precision. 0/null
 * ("unrated") stays null.
 */
export function normalizeQualityTo5(quality: number | null | undefined): number | null {
  if (quality == null) return null;
  const q = Number(quality);
  if (!Number.isFinite(q) || q <= 0) return null;
  return (q * 5) / 3;
}
