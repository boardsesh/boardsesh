import dayjs, { type Dayjs } from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import utc from 'dayjs/plugin/utc';
// Registering a locale doesn't activate it — `setRelativeTimeLocale` does that.
// Importing them here rather than at the call site keeps them on the same dayjs
// module instance as the formatter below, so it can't depend on the bundler
// deduping two copies of dayjs.
import 'dayjs/locale/de';
import 'dayjs/locale/es';
import 'dayjs/locale/fr';

dayjs.extend(relativeTime);
dayjs.extend(utc);

/** App locale -> dayjs locale id. `en-US` is dayjs's built-in default. */
const DAYJS_LOCALE_BY_APP_LOCALE: Record<string, string> = {
  'en-US': 'en',
  en: 'en',
  de: 'de',
  es: 'es',
  fr: 'fr',
};

/**
 * Points `fromNow()` at a language. Without this, `formatTickRelativeTime`
 * renders "6 minutes ago" for every locale — dayjs defaults to `en` and nothing
 * ever changed it, so Spanish and French have shipped English timestamps.
 *
 * dayjs's active locale is module-global, which is why this is opt-in rather
 * than automatic: a server rendering several languages in one process would
 * leak one request's locale into the next. Call it only from a single-language
 * process (the mobile app, on i18n init and on every language change). Web
 * surfaces render through their own `app/lib/format-tick-time` and are
 * unaffected either way.
 *
 * Unknown locales fall back to `en` rather than throwing — a formatter is never
 * worth crashing a screen over.
 */
export function setRelativeTimeLocale(appLocale: string): void {
  dayjs.locale(DAYJS_LOCALE_BY_APP_LOCALE[appLocale] ?? 'en');
}

function requireString(climbedAt: string): string {
  // dayjs.utc(undefined) silently returns "now", which would corrupt sorts and
  // bucket bounds. The signatures already require `string`, but we guard at
  // runtime so a stray `?.` or future caller can't bypass the type system.
  if (!climbedAt) {
    throw new TypeError('format-tick-time helpers require a non-empty timestamp string');
  }
  return climbedAt;
}

// `boardsesh_ticks.climbed_at` (and `created_at` / `updated_at`) are naive
// `timestamp` columns. Drizzle returns them as strings with no `Z` suffix,
// so any `dayjs(<naiveString>)` call would parse them as browser-local time.
// These helpers parse through `dayjs.utc(...)` to recover the absolute moment
// before any rendering, sorting, or bucketing.

export function parseTickTime(climbedAt: string): Dayjs {
  return dayjs.utc(requireString(climbedAt)).local();
}

export function formatTickRelativeTime(climbedAt: string): string {
  return dayjs.utc(requireString(climbedAt)).fromNow();
}

export function formatTickAbsoluteTime(climbedAt: string, format: string): string {
  return parseTickTime(climbedAt).format(format);
}

export function tickTimeMs(climbedAt: string): number {
  return dayjs.utc(requireString(climbedAt)).valueOf();
}
