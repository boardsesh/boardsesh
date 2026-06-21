const MAX_CLIMB_STARS = 5;

/**
 * Convert a climb's quality_average into an integer 0-5 star count.
 *
 * quality_average is the canonical 1-5 scale on every board (migrations
 * 0115/0116 backfilled Aurora's 1-3 ratings to 1-5; Kilter Grips and MoonBoard
 * are native 1-5), so the rating maps straight to a star count — round and
 * clamp to 0-5. Unrated climbs (quality <= 0, null, or NaN) get 0 stars.
 *
 * Historically this multiplied by a per-board factor (Aurora x5, MoonBoard x3)
 * to fold differing source scales onto a 0-15 "queue scale". Those scales are
 * now unified, so the multiplier only saturated the result (4.5 x 5 -> 22 -> 15)
 * and the board argument is no longer needed.
 */
export function getClimbStars(qualityAverage: number | string | null | undefined): number {
  const quality = Number(qualityAverage);
  if (!Number.isFinite(quality) || quality <= 0) {
    return 0;
  }
  return Math.min(MAX_CLIMB_STARS, Math.round(quality));
}
