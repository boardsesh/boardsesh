/**
 * Human-readable byte size for user-facing copy (the offline download estimate,
 * issue #3616).
 *
 * Base-10 units (1 MB = 1,000,000 bytes), matching what iOS and Android report
 * for downloads and storage — a 269,873,152-byte artifact reads as "270 MB" here
 * and in the Files app, rather than the 257 MiB a base-2 divisor would print.
 *
 * Deliberately NOT `Intl.NumberFormat`'s `style: 'unit'`: Hermes ships an
 * incomplete Intl (see the `no-restricted-properties` block in the repo's
 * vite.config.ts — RelativeTimeFormat/ListFormat crash release builds), so the
 * unit tables are not worth betting user-visible copy on. `toLocaleString` for
 * digits only is already used elsewhere in the app and is safe.
 */

const KB = 1_000;
const MB = 1_000_000;
const GB = 1_000_000_000;

function localized(value: number, maximumFractionDigits: number, locale: string): string {
  return value.toLocaleString(locale, { maximumFractionDigits });
}

/**
 * `locale` is required, not optional: it must be the **app's** i18n language
 * (`i18n.language`), never the device's. The result is interpolated into a
 * translated sentence, so "1,2 GB" belongs next to Spanish copy even on an en-US
 * device — and an omitted locale would silently format against the host instead.
 */
export function formatBytes(bytes: number, locale: string): string {
  // A negative or non-finite size can only mean a corrupt manifest; clamp rather
  // than render "-1 B" into a dialog. Zero is NOT clamped here — it's a legitimate
  // (if odd) artifact size and falls through to the "0 B" branch on its own, which
  // keeps this in step with estimateScopeDownload treating `bytes: 0` as a real
  // estimate rather than a miss.
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  // Whole units below GB: sub-MB precision is noise next to a "download this?"
  // decision, and it keeps the decimal separator out of the common case.
  if (bytes >= GB) return `${localized(bytes / GB, 1, locale)} GB`;
  if (bytes >= MB) return `${localized(Math.round(bytes / MB), 0, locale)} MB`;
  if (bytes >= KB) return `${localized(Math.round(bytes / KB), 0, locale)} KB`;
  return `${localized(bytes, 0, locale)} B`;
}
