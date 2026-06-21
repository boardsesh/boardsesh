import { formatTickRelativeTime, tickTimeMs } from '@boardsesh/profile-stats';

// Locale-aware "5 minutes ago"-style formatting for ISO timestamps, shared by
// any surface that shows recency (draft lists, the BLE device picker's
// last-connected subtitle, ...). Lives in lib/ so feature modules don't have
// to import each other for it.
//
// Delegates to the dayjs-based helper in @boardsesh/profile-stats (also used by
// the logbook/feed surfaces). It must NOT use Intl.RelativeTimeFormat: Hermes
// ships an incomplete Intl without it, so constructing one throws a TypeError
// that release builds promote to a native crash — Node-based tests never see it.
export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return '';
  // formatTickRelativeTime throws on empty input and renders "Invalid Date" for
  // unparseable strings, so validate first to keep the empty-string contract.
  if (!Number.isFinite(tickTimeMs(iso))) return '';
  return formatTickRelativeTime(iso);
}

export type CompactAgoUnit = 'now' | 'minutes' | 'hours' | 'days' | 'weeks';

/**
 * Buckets an elapsed duration into a compact "5m / 2h / 3d / 1w"-style unit +
 * count, for tight chrome (the on-wall banner) where the full locale-aware
 * "5 minutes ago" is too wide. Pure + clock-injected so it's deterministic in
 * tests; the caller maps the unit to a localized label. Clamps negatives (a
 * clock skew where `fromMs` is slightly in the future) to "now".
 */
export function compactAgoParts(fromMs: number, nowMs: number): { unit: CompactAgoUnit; count: number } {
  if (!Number.isFinite(fromMs) || !Number.isFinite(nowMs)) return { unit: 'now', count: 0 };
  const diffMs = Math.max(0, nowMs - fromMs);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return { unit: 'now', count: 0 };
  if (minutes < 60) return { unit: 'minutes', count: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { unit: 'hours', count: hours };
  const days = Math.floor(hours / 24);
  if (days < 7) return { unit: 'days', count: days };
  return { unit: 'weeks', count: Math.floor(days / 7) };
}
