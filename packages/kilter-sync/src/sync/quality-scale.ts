/**
 * Kilter Grips quality-average pass-through (range guard only).
 *
 * The Kilter Grips catalog reports one `qualityAverage` per (climb, angle) that
 * is ALREADY on the 1-5 scale: Kilter migrated its legacy 1-3 per-user ratings
 * to 1-5 itself (round(q × 5/3): 1→2, 2→3, 3→5 — which is why the synced
 * per-user ratings in board_climb_ratings are 1-5 with no 1s or 4s). The
 * aggregate is computed from those 1-5 ratings, so it needs NO scale conversion.
 *
 * HISTORY: an earlier version applied an affine `2q − 1` to "pre-cutover"
 * climbs on the false premise that the aggregate was a mixed 1-3/1-5 blend. That
 * double-converted every climb rated ≥3 up to 5 (clamped), so ~88% of
 * well-ascended Kilter climbs rendered at ≥4.5 stars and the median hit exactly
 * 5.0 — a regression on top of the original (correct) data. The clustering at
 * ~3.0 the conversion tried to "fix" is Kilter's own legacy-migration artifact
 * and matches what the Kilter app shows; it was never ours to rescale.
 *
 * (Aurora-synced boards like Tension ARE genuinely 1-3 and are still rescaled to
 * 1-5 via normalizeQualityTo5 in aurora-sync — a separate, correct code path.)
 */

/**
 * Store a Kilter Grips `qualityAverage` verbatim (it is already 1-5), guarding
 * only against non-ratings.
 *
 * - `null`/`undefined`/non-finite/`< 1`/`> 5` → `null` (a 1-5 star scale has no
 *   valid value below 1 — anything in `(0, 1)` is as much garbage as `≤ 0`;
 *   above 5 is garbage too).
 * - otherwise → `raw`, unchanged.
 */
export function correctGripsQualityAverage(raw: number | null | undefined): number | null {
  if (raw == null) return null;
  const quality = Number(raw);
  if (!Number.isFinite(quality) || quality < 1 || quality > 5) return null;
  return quality;
}
