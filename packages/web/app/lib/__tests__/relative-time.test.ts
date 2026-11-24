import { describe, expect, it } from 'vite-plus/test';
import { relativeTimeFormatter } from '../relative-time';

describe('relativeTimeFormatter', () => {
  const now = Date.parse('2026-11-24T12:00:00.000Z');
  const format = relativeTimeFormatter('en-US', now);

  it('names the largest whole unit in the page language', () => {
    expect(format('2026-11-24T09:00:00.000Z')).toBe('3 hours ago');
    expect(format('2026-11-23T12:00:00.000Z')).toBe('yesterday');
    expect(format('2026-11-10T12:00:00.000Z')).toBe('2 weeks ago');
  });

  it('reads under a minute as now', () => {
    expect(format('2026-11-24T11:59:30.000Z')).toBe('this minute');
  });

  it('speaks the locale it is given', () => {
    expect(relativeTimeFormatter('de', now)('2026-11-24T09:00:00.000Z')).toBe('vor 3 Stunden');
  });
});
