// IANA-timezone helpers for external platform exports. Timestamps are stored
// UTC; platforms like Strava want the activity's wall-clock local time, which
// can only be reconstructed with the timezone the device reported.

/**
 * Validate a client-supplied IANA timezone. Returns the trimmed zone name when
 * the runtime's ICU data knows it, null otherwise — callers treat null as
 * "no timezone recorded" rather than an error (a bad zone string must never
 * fail ending a session).
 */
export function normalizeIanaTimezone(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 64) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed });
    return trimmed;
  } catch {
    return null;
  }
}

/**
 * Convert a UTC ISO timestamp to the wall-clock local time in the given zone,
 * formatted "YYYY-MM-DDTHH:mm:ss" (no offset designator — Strava's
 * start_date_local is interpreted literally). Falls back to the input
 * unchanged when no/invalid timezone is available, which preserves the
 * UTC-as-local behavior for sessions recorded before timezones were captured.
 */
export function utcIsoToLocalWallClock(utcIso: string, timeZone: string | null | undefined): string {
  if (!timeZone) return utcIso;
  const instant = new Date(utcIso);
  if (Number.isNaN(instant.getTime())) return utcIso;
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    const parts: Record<string, string> = {};
    for (const part of formatter.formatToParts(instant)) {
      parts[part.type] = part.value;
    }
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
  } catch {
    return utcIso;
  }
}
