import { getCachedDateTimeFormat } from '../intl-formatter-cache';

const ARCHIVE_DATE_OPTIONS: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' };

/**
 * When a wall was archived, as a short date in the reader's language
 * ("6 Oct 2026", "Oct 6, 2026"), or null for a value that is not a date.
 *
 * Null rather than a placeholder: every caller has a sentence without the date.
 */
export function formatSprayArchiveDate(archivedAt: string | null | undefined, locale: string): string | null {
  if (!archivedAt) return null;
  const date = new Date(archivedAt);
  if (Number.isNaN(date.getTime())) return null;
  return getCachedDateTimeFormat(locale, ARCHIVE_DATE_OPTIONS).format(date);
}
