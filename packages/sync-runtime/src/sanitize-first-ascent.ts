/**
 * Guard against impossible `fa_at` / `fa_username` values landing in
 * `board_climb_stats` from upstream (Aurora / Kilter Grips) catalog syncs.
 *
 * Both syncs write these fields verbatim from the upstream payload (see the
 * comment in aurora-sync's shared-sync.ts on why null must pass through
 * unchanged — it is how Aurora signals a correction). But upstream data has
 * shipped occasional garbage: dates decades in the future (e.g. 2033) or
 * before the boards existed (pre-2016), which then render as a nonsensical
 * "first ascent" on the climb page (issue #3536).
 *
 * This is deliberately a pure, dependency-free helper (mirrors
 * upstream-playlist-ownership.ts in this package) so both writers can share
 * one range check instead of duplicating the boundary logic. It only ever
 * NULLS a bad value — never invents or clamps one, since a clamped date would
 * be a fabricated fact worse than an honest blank.
 *
 * Deliberately out of scope: the FA/count-contradiction cases (a climb with a
 * `fa_at` but zero recorded ascents, or ascents with no `fa_at`) are a
 * different bug needing its own reasoning about which side is authoritative
 * — not addressed here.
 */

/**
 * Earliest plausible first-ascent instant (2016-01-01T00:00:00Z), as epoch
 * milliseconds. A number (not a shared `Date`) on purpose: `Object.freeze`
 * cannot stop `Date#setTime`-style mutation, so a shared Date would let any
 * caller silently move the boundary for everyone.
 *
 * The bound is chosen for the Aurora-board catalogs these writers ingest —
 * the earliest Aurora boards date to around 2016, so anything before that is
 * upstream garbage *for these feeds*. MoonBoard climbs are older (the
 * original MoonBoard dates to ~2005), but MoonBoard imports don't flow
 * through these writers today; revisit this bound before routing a MoonBoard
 * catalog through this guard.
 */
export const FIRST_ASCENT_EARLIEST_MS = Date.parse('2016-01-01T00:00:00.000Z');

/** Tolerance for minor upstream/server clock skew so a genuinely-just-sent FA isn't nulled. */
const FUTURE_GRACE_MS = 24 * 60 * 60 * 1000;

export type FirstAscentFields = {
  faUsername: string | null;
  faAt: string | null;
};

/**
 * Returns `fields` unchanged when `faAt` is null (a legitimate correction
 * signal, or the count-contradiction case — explicitly out of scope here) or
 * parses to a plausible date. Returns both fields nulled together when `faAt`
 * is unparseable, before the board existed, or further in the future than a
 * one-day clock-skew grace window allows.
 */
export function sanitizeFirstAscent(fields: FirstAscentFields, now: Date = new Date()): FirstAscentFields {
  if (fields.faAt == null) {
    return fields;
  }

  const parsed = new Date(fields.faAt);
  const parsedMs = parsed.getTime();
  const latestAllowedMs = now.getTime() + FUTURE_GRACE_MS;

  if (Number.isNaN(parsedMs) || parsedMs < FIRST_ASCENT_EARLIEST_MS || parsedMs > latestAllowedMs) {
    return { faUsername: null, faAt: null };
  }

  return fields;
}
