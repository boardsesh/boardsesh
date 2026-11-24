const RELATIVE_UNITS: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

/**
 * "3 hours ago" in the page's language, measured from `nowMs`. dayjs's relative
 * time is English-only on the website, so this uses `Intl.RelativeTimeFormat`.
 * Under a minute reads as "this minute".
 */
export function relativeTimeFormatter(locale: string, nowMs: number): (iso: string) => string {
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  return (iso) => {
    const seconds = (Date.parse(iso) - nowMs) / 1000;
    for (const [unit, size] of RELATIVE_UNITS) {
      if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
    }
    return format.format(0, 'minute');
  };
}
