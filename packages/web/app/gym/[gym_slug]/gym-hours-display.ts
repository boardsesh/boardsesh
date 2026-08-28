// Formatting for the gym page's "Confirmed <date>" stamp. Pure so the date
// handling is testable without rendering the page.

/**
 * Format the ISO timestamp a gym last confirmed its hours as a plain date.
 *
 * Pinned to UTC, matching how the stamp is stored and how the manage console
 * formats its own dates: rendering in the viewer's zone would push a late-evening
 * confirmation to the following day for anyone east of the gym, so two climbers
 * looking at the same page would read different confirmation dates.
 *
 * Returns null for a missing or unparseable value so the caller renders nothing
 * rather than "Invalid Date".
 */
export function formatHoursConfirmedDate(isoTimestamp: string | null | undefined, locale: string): string | null {
  if (!isoTimestamp) {
    return null;
  }

  const confirmedAt = new Date(isoTimestamp);
  if (Number.isNaN(confirmedAt.getTime())) {
    return null;
  }

  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(confirmedAt);
}
