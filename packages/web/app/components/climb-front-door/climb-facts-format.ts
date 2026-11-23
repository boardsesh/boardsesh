/**
 * Formatting shared by the climb page's facts list, angle table and "About
 * this climb" paragraph, so the three never print the same number two ways.
 */

/**
 * A first-ascent timestamp as a date in the page's locale ("1 Mar 2024",
 * "2024年3月1日"), or null when there is no usable date. Read in UTC: the column
 * is a date, and a reader west of Greenwich must not see the day before.
 */
export function formatFirstAscentDate(rawDate: string | null | undefined, locale: string): string | null {
  if (!rawDate) return null;
  const parsed = new Date(rawDate);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
    parsed,
  );
}

/** A 1-5 quality average with exactly one decimal, as the heading prints it ("3.0", "3,0"). */
export function formatQualityAverage(average: number, locale: string): string {
  return new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(average);
}

/**
 * A stats-row count as a whole number. The column arrives as Postgres's numeric
 * string, and i18next only picks a plural form for a real number. Anything that
 * is not a finite count above zero reads as zero, so callers can drop it.
 */
export function sendCount(rawCount: number | string | null | undefined): number {
  const count = Number(rawCount ?? 0);
  return Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
}
