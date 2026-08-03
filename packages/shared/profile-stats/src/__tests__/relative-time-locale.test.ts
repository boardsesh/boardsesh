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
