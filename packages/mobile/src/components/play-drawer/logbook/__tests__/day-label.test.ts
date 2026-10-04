import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

// Pinned so the local-day maths below doesn't depend on the host's default TZ.
// Europe/Amsterdam observes DST, which the yesterday case needs. The formatter
// cache is keyed without TZ, hence the fresh module import (see the note in
// LogbookEntryRow.tsx).
beforeAll(() => {
  vi.stubEnv('TZ', 'Europe/Amsterdam');
  vi.resetModules();
});
afterAll(() => {
  vi.unstubAllEnvs();
});

const keys = { todayKey: '2026-10-03', yesterdayKey: '2026-10-02', todayLabel: 'TODAY', yesterdayLabel: 'YESTERDAY' };

describe('formatLedgerDayLabel', () => {
  it('names today and yesterday', async () => {
    const { formatLedgerDayLabel } = await import('../day-label');
    expect(formatLedgerDayLabel('2026-10-03', keys)).toBe('TODAY');
    expect(formatLedgerDayLabel('2026-10-02', keys)).toBe('YESTERDAY');
  });

  it('gives a weekday and no year for an earlier day this year', async () => {
    const { formatLedgerDayLabel } = await import('../day-label');
    const label = formatLedgerDayLabel('2026-09-28', { ...keys, locale: 'en-GB' });
    expect(label).toContain('Mon');
    expect(label).toContain('28');
    expect(label).toContain('Sep');
    expect(label).not.toContain('2026');
  });

  it('gives the year for a day in an earlier year', async () => {
    const { formatLedgerDayLabel } = await import('../day-label');
    const label = formatLedgerDayLabel('2025-12-31', { ...keys, locale: 'en-GB' });
    expect(label).toContain('31');
    expect(label).toContain('Dec');
    expect(label).toContain('2025');
  });
});

describe('formatLedgerDate', () => {
  it('drops the year only within the current year', async () => {
    const { formatLedgerDate } = await import('../day-label');
    const thisYear = formatLedgerDate('2026-09-28', '2026-10-03', 'en-GB');
    expect(thisYear).toContain('28');
    expect(thisYear).not.toContain('2026');
    expect(formatLedgerDate('2025-09-28', '2026-10-03', 'en-GB')).toContain('2025');
  });
});

describe('ledgerDayKeys', () => {
  it('returns local keys for an instant, not the UTC date', async () => {
    const { ledgerDayKeys } = await import('../day-label');
    // 23:30 UTC on 2 Oct is already 01:30 on 3 Oct in Amsterdam (UTC+2).
    expect(ledgerDayKeys(Date.parse('2026-10-02T23:30:00Z'))).toEqual({
      todayKey: '2026-10-03',
      yesterdayKey: '2026-10-02',
    });
  });

  it('steps back one calendar day, not 24 hours, on a clock-change day', async () => {
    const { ledgerDayKeys } = await import('../day-label');
    // Spring forward: 29 Mar 2026 is a 23-hour day in Amsterdam. From 00:30
    // local on the 30th, 24 hours back is 23:30 on the 28th, two days back.
    expect(ledgerDayKeys(Date.parse('2026-03-29T22:30:00Z'))).toEqual({
      todayKey: '2026-03-30',
      yesterdayKey: '2026-03-29',
    });
    // Fall back: 25 Oct 2026 is a 25-hour day.
    expect(ledgerDayKeys(Date.parse('2026-10-25T23:30:00Z'))).toEqual({
      todayKey: '2026-10-26',
      yesterdayKey: '2026-10-25',
    });
  });
});
