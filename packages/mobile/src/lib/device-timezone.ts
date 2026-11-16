// The device's IANA timezone, used for feed grouping and session exports so
// external platforms (Strava) can show wall-clock local time. Hermes
// ships Intl, but guard anyway — a missing zone is fine (export falls back to
// UTC), a crash ending a session is not.
export function getDeviceTimezone(): string | undefined {
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    // iOS Hermes reports GMT for the same zero-offset zone Android calls UTC.
    // Keep equivalent device zones consistent in request and cache keys.
    if (timeZone === 'GMT') return 'UTC';
    return timeZone || undefined;
  } catch {
    return undefined;
  }
}
