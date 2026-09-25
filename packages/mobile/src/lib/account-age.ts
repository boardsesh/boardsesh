// How old the signed-in account is, from the profile's `createdAt` (#5654).
//
// The one definition behind every `account_age_hours` event prop, so events
// that carry it can be joined or cut by age without off-by-one-hour drift at
// the 24 h and 7-day cut-offs: whole hours rounded down, and null when the
// creation time is unknown. Keep other events' account-age props on these two
// functions rather than converting again.

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * Milliseconds from the account's creation to `atMs`, or null when the creation
 * time is missing or unreadable. `createdAt` is server time: a phone clock
 * running behind can put it in the future, and that account is as new as they
 * come, so the age never goes below zero.
 */
export function accountAgeMs(createdAt: string | null | undefined, atMs: number): number | null {
  if (!createdAt) return null;
  const createdAtMs = Date.parse(createdAt);
  if (!Number.isFinite(createdAtMs)) return null;
  return Math.max(0, atMs - createdAtMs);
}

/** Whole hours since the account was created, rounded down, or null when that is unknown. */
export function accountAgeHours(createdAt: string | null | undefined, atMs: number): number | null {
  const ageMs = accountAgeMs(createdAt, atMs);
  return ageMs === null ? null : Math.floor(ageMs / MS_PER_HOUR);
}
