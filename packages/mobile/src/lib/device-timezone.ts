// The device's IANA timezone, reported to the backend when ending a session so
// external platform exports (Strava) can show wall-clock local time. Hermes
// ships Intl, but guard anyway — a missing zone is fine (export falls back to
// UTC), a crash ending a session is not.
export function getDeviceTimezone(): string | undefined {
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return timeZone || undefined;
  } catch {
    return undefined;
  }
}
