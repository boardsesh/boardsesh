/**
 * Per-user UTC-offset inference for cross-source tick adoption.
 *
 * Background (the 3,208-duplicate bug): pre-PR4 the Aurora pull and the JSON
 * import stored a tick's `climbed_at` as the user's LOCAL wall-clock time
 * relabelled as UTC (a naive "YYYY-MM-DD HH:MM:SS" parsed as UTC), while the
 * Kilter PowerSync stream carries a true-UTC `created_at`. So the same physical
 * ascent lands with two timestamps that differ by the user's whole UTC offset
 * (e.g. +10h). The natural-key adoption in the sync paths matches on
 * (user, board, climb_uuid, angle, |Δt| ≤ 60s) — with a whole-offset gap the
 * ±60s window never matches, so the sync inserts a duplicate instead of
 * adopting the existing row.
 *
 * The fix: infer the user's offset from the ticks that DO line up (same climb
 * and angle) and accept an adoption when the timestamp gap is within tolerance
 * of that offset. Post-PR4 both sides write honest UTC, so the offset rounds to
 * 0 and the plain ±60s fast path handles everything; the inference only earns
 * its keep on historical, pre-fix rows.
 *
 * Pure + DB-agnostic so both kilter-sync (applyLogs) and aurora-sync /
 * web (the Aurora live-pull cross-source claim) can share one implementation.
 *
 * NOTE (#3909): this inference is NOT retired by the corrective backfill in
 * `./ticks/climbed-at-correction.ts`. That classifier deliberately ABSTAINS on
 * every row whose offset it cannot prove — a climber with no honest-UTC anchor
 * keeps a shifted history forever — so removing the offset path here would
 * re-open the 3,208-duplicate bug for the whole abstain cohort.
 */

/** A tick reduced to the fields the offset inference needs. */
export type TickTimeSample = {
  climbUuid: string;
  angle: number;
  /** climbed_at (or the incoming log's created_at) as epoch milliseconds. */
  climbedAtMs: number;
};

/** Real-world UTC offsets top out at +14:00 / −12:00; cap candidate gaps here. */
export const MAX_USER_UTC_OFFSET_SECONDS = 14 * 60 * 60;

/**
 * Round the inferred offset to the nearest 15 minutes. Captures whole-hour,
 * half-hour (+9:30) and quarter-hour (+5:45) zones while snapping away the
 * sub-minute jitter between a client-stamped and a server-stamped timestamp.
 */
export const OFFSET_ROUNDING_SECONDS = 15 * 60;

/** Default adoption tolerance: a local clock can drift tens of seconds. */
export const NATURAL_KEY_TOLERANCE_SECONDS = 60;

function keyOf(sample: { climbUuid: string; angle: number }): string {
  return `${sample.climbUuid} ${sample.angle}`;
}

/**
 * One Δt per (climb_uuid, angle) shared by both sets — the raw material both
 * the median offset below and the #3909 correction classifier are derived from.
 *
 * For each key present in BOTH sets, the single CLOSEST existing↔incoming
 * pair's `existing − incoming` is kept, so a busy key can't dominate the
 * sample. Δt gaps beyond ±14h are dropped as implausible offsets (genuinely
 * different climbs that happen to share a key).
 *
 * Returned in the iteration order of the incoming keys — callers that need a
 * median or a MAD sort their own copy.
 *
 * Extracted so `inferUserUtcOffsetSeconds` and the correction classifier
 * consume ONE implementation: the classifier needs the per-key list to compute
 * a median absolute deviation, and re-deriving it there would be the same
 * algorithm written twice, free to diverge invisibly.
 */
export function perKeyClosestDeltasMs(existing: TickTimeSample[], incoming: TickTimeSample[]): number[] {
  if (existing.length === 0 || incoming.length === 0) return [];

  const existingByKey = new Map<string, number[]>();
  for (const sample of existing) {
    const key = keyOf(sample);
    const list = existingByKey.get(key);
    if (list) list.push(sample.climbedAtMs);
    else existingByKey.set(key, [sample.climbedAtMs]);
  }

  const incomingByKey = new Map<string, number[]>();
  for (const sample of incoming) {
    const key = keyOf(sample);
    const list = incomingByKey.get(key);
    if (list) list.push(sample.climbedAtMs);
    else incomingByKey.set(key, [sample.climbedAtMs]);
  }

  const maxOffsetMs = MAX_USER_UTC_OFFSET_SECONDS * 1000;
  const perKeyDeltasMs: number[] = [];
  for (const [key, incomingMs] of incomingByKey) {
    const existingMs = existingByKey.get(key);
    if (!existingMs) continue;
    // Closest existing↔incoming pair for this key.
    let best: number | null = null;
    for (const inc of incomingMs) {
      for (const ex of existingMs) {
        const delta = ex - inc;
        if (Math.abs(delta) > maxOffsetMs) continue;
        if (best === null || Math.abs(delta) < Math.abs(best)) best = delta;
      }
    }
    if (best !== null) perKeyDeltasMs.push(best);
  }

  return perKeyDeltasMs;
}

/** Median of a non-empty list. Copies before sorting — never mutates the input. */
export function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Snap an offset in seconds to the nearest OFFSET_ROUNDING_SECONDS grid point. */
export function roundOffsetSeconds(offsetSeconds: number): number {
  return Math.round(offsetSeconds / OFFSET_ROUNDING_SECONDS) * OFFSET_ROUNDING_SECONDS;
}

/**
 * Infer the user's UTC offset (in SECONDS, `existing − incoming`) from the
 * ticks that share a (climb_uuid, angle) between their existing history and the
 * incoming batch.
 *
 * Takes the MEDIAN of `perKeyClosestDeltasMs` (robust to a minority of
 * mismatched keys / mixed honest+shifted history) and rounds to the nearest 15
 * minutes.
 *
 * Returns the offset in seconds (may be 0), or `null` when there are no
 * overlapping keys to infer from — the caller then relies on the ±60s fast
 * path alone.
 */
export function inferUserUtcOffsetSeconds(existing: TickTimeSample[], incoming: TickTimeSample[]): number | null {
  const perKeyDeltasMs = perKeyClosestDeltasMs(existing, incoming);
  if (perKeyDeltasMs.length === 0) return null;
  return roundOffsetSeconds(medianOf(perKeyDeltasMs) / 1000);
}

/**
 * Adoption match SCORE for an existing tick vs an incoming log — lower is a
 * closer match, `null` means no match. Two tiers:
 *
 *   - Fast path (|Δt| ≤ tolerance): the honest same-instant ascent. Score lands
 *     in [0, tolerance].
 *   - Offset path (|Δt − offset| ≤ tolerance, only when an offset was inferred):
 *     a pre-fix timezone-shifted historical row. Score lands in
 *     (tolerance, 2·tolerance].
 *
 * The tiering guarantees a fast-path candidate ALWAYS outranks an offset-path
 * one. So when a shifted-history user has two distinct same-(climb, angle)
 * ascents and an incoming log sits within tolerance of BOTH the true
 * same-instant row and an offset-distant DISTINCT row, the caller (which picks
 * the lowest score) links the same-instant row and never merges the distinct
 * ascent. Within a tier the numerically closest wins.
 *
 * `offsetSeconds` null ⇒ fast path only.
 */
export function adoptionMatchScoreSeconds(
  existingMs: number,
  incomingMs: number,
  offsetSeconds: number | null,
  toleranceSeconds: number = NATURAL_KEY_TOLERANCE_SECONDS,
): number | null {
  const deltaMs = existingMs - incomingMs;
  const toleranceMs = toleranceSeconds * 1000;
  const absDeltaMs = Math.abs(deltaMs);
  if (absDeltaMs <= toleranceMs) return absDeltaMs / 1000;
  if (offsetSeconds !== null && offsetSeconds !== 0) {
    const offsetDistanceMs = Math.abs(deltaMs - offsetSeconds * 1000);
    if (offsetDistanceMs <= toleranceMs) return toleranceSeconds + offsetDistanceMs / 1000;
  }
  return null;
}

/**
 * Does an existing tick's climbed_at match an incoming log's timestamp for
 * adoption? True when the gap is within tolerance of 0 (the honest-UTC fast
 * path) OR — when an offset was inferred — within tolerance of that offset.
 * Thin boolean wrapper over adoptionMatchScoreSeconds (single source of truth).
 *
 * `offsetSeconds` null ⇒ fast path only.
 */
export function climbedAtMatchesForAdoption(
  existingMs: number,
  incomingMs: number,
  offsetSeconds: number | null,
  toleranceSeconds: number = NATURAL_KEY_TOLERANCE_SECONDS,
): boolean {
  return adoptionMatchScoreSeconds(existingMs, incomingMs, offsetSeconds, toleranceSeconds) !== null;
}

/**
 * Is `deltaMs` shaped like a whole UTC-offset shift rather than a real change
 * of instant? True when the gap is a plausible non-zero zone offset (|Δ| ≤ 14h,
 * rounding to a non-zero 15-minute grid point) and sits within `tolerance` of
 * that grid point.
 *
 * The #3909 writer guard (packages/aurora-sync/src/sync/apply-user-logbook.ts).
 * A corrected legacy tick stores the true UTC instant while the Aurora pull
 * keeps sending the climber's local wall clock relabelled UTC, so the
 * by-aurora-id update path sees a pure whole-offset difference and would write
 * the shifted value straight back — the correction self-reverts inside one sync
 * cycle. Recognising that exact shape lets the pull PRESERVE the stored
 * climbed_at while still applying every other field.
 *
 * Deliberately NARROWER than `climbedAtMatchesForAdoption`: the ±60s fast path
 * is excluded, so a genuine upstream edit of a few seconds/minutes still
 * propagates. Only a timezone-shaped gap is suppressed. `Math.round`'s
 * half-up-toward-+∞ behaviour is irrelevant here — a value exactly on a
 * 7.5-minute boundary is more than `tolerance` from either grid point and
 * fails the second test whichever way it snaps.
 */
export function isWholeUtcOffsetShift(
  deltaMs: number,
  toleranceSeconds: number = NATURAL_KEY_TOLERANCE_SECONDS,
): boolean {
  if (!Number.isFinite(deltaMs)) return false;
  if (Math.abs(deltaMs) > MAX_USER_UTC_OFFSET_SECONDS * 1000) return false;
  const roundedSeconds = roundOffsetSeconds(deltaMs / 1000);
  if (roundedSeconds === 0) return false;
  return Math.abs(deltaMs - roundedSeconds * 1000) <= toleranceSeconds * 1000;
}
