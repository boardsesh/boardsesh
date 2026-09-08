import { afterEach, describe, expect, it } from 'vitest';

import { formatTickRelativeTime, setRelativeTimeLocale } from '../format-tick-time';

// dayjs's active locale is module-global, so leaving it set would leak into any
// test that runs after this file.
afterEach(() => setRelativeTickLocaleToDefault());

function setRelativeTickLocaleToDefault() {
  setRelativeTimeLocale('en-US');
}

/** An ISO timestamp `minutes` in the past, in the naive-UTC shape ticks use. */
function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString().replace('Z', '');
}

describe('setRelativeTimeLocale', () => {
  it('renders relative time in the selected language', () => {
    setRelativeTimeLocale('de');
    expect(formatTickRelativeTime(minutesAgo(6))).toBe('vor 6 Minuten');

    setRelativeTimeLocale('es');
    expect(formatTickRelativeTime(minutesAgo(6))).toBe('hace 6 minutos');

    setRelativeTimeLocale('fr');
    expect(formatTickRelativeTime(minutesAgo(6))).toBe('il y a 6 minutes');
  });

  it('renders English for en-US', () => {
    setRelativeTimeLocale('en-US');
    expect(formatTickRelativeTime(minutesAgo(6))).toBe('6 minutes ago');
  });

  it('falls back to English rather than throwing on an unknown locale', () => {
    setRelativeTimeLocale('kl-GL');
    expect(formatTickRelativeTime(minutesAgo(6))).toBe('6 minutes ago');
  });

  it('keeps the default English until something opts in', () => {
    // Guards the web surfaces: they never call the setter, so importing this
    // package must not change how they render.
    expect(formatTickRelativeTime(minutesAgo(6))).toBe('6 minutes ago');
  });
});

describe('formatTickRelativeTime with an explicit nowMs', () => {
  it('renders against the pinned instant instead of the real wall clock', () => {
    // Mobile's screenshot-mode frozen clock (packages/mobile/src/lib/clock.ts)
    // passes this so two captures of the same seeded tick render identical text
    // no matter when the capture actually runs.
    const frozenNow = Date.parse('2026-01-15T12:00:00.000Z');
    const climbedAt = '2026-01-15T09:00:00.000';
    expect(formatTickRelativeTime(climbedAt, frozenNow)).toBe('3 hours ago');
  });

  it('is deterministic across repeated calls, unlike the real-clock default', () => {
    const frozenNow = Date.parse('2026-01-15T12:00:00.000Z');
    const climbedAt = '2026-01-15T11:59:00.000';
    const first = formatTickRelativeTime(climbedAt, frozenNow);
    const second = formatTickRelativeTime(climbedAt, frozenNow);
    expect(first).toBe(second);
    expect(first).toBe('a minute ago');
  });
});
