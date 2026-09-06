/**
 * Build one `Intl.DateTimeFormat` for order timestamps, pinned to UTC.
 *
 * An order date is server-rendered first and then re-rendered on the client
 * once React hydrates. Those are two different runtimes — a US server, a
 * browser in any time zone — and `Intl.DateTimeFormat` defaults to the
 * runtime's local zone, so the same instant would print as two different
 * clock times and React would flag a hydration mismatch. Pinning
 * `timeZone: 'UTC'` makes both renders agree, following the same fix already
 * used for weekday labels in `insights-tab.tsx`.
 */
export function createOrderDateFormatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' });
}
