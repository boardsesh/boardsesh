// Best-effort device IANA timezone, reported when ending a session so
// external platform exports (Strava) can show wall-clock local time. A
// missing zone is fine (export falls back to UTC); a crash ending a session
// is not.
export function getBrowserTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}
