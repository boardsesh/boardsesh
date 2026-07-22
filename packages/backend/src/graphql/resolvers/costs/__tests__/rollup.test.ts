import { describe, it, expect } from 'vite-plus/test';
import type { CostEntry } from '@boardsesh/db/schema';
import { buildRunningCostsReport, previousMonths, monthKeyFromDate } from '../rollup';

// Minimal CostEntry factory — the rollup only reads kind/category/amountCents/
// startMonth/endMonth, but the type needs every column, so fill the rest.
function entry(
  over: Partial<CostEntry> & Pick<CostEntry, 'kind' | 'category' | 'amountCents' | 'startMonth'>,
): CostEntry {
  return {
    id: 1,
    currency: 'USD',
    endMonth: null,
    note: null,
    createdBy: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    label: 'x',
    ...over,
  };
}

describe('monthKeyFromDate', () => {
  it('formats a UTC date as YYYY-MM', () => {
    expect(monthKeyFromDate(new Date('2026-03-15T12:00:00Z'))).toBe('2026-03');
    expect(monthKeyFromDate(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01');
    expect(monthKeyFromDate(new Date('2026-12-31T23:59:59Z'))).toBe('2026-12');
  });
});

describe('previousMonths', () => {
  it('returns count months ending at current, ascending', () => {
    expect(previousMonths('2026-03', 3)).toEqual(['2026-01', '2026-02', '2026-03']);
  });

  it('crosses the year boundary', () => {
    expect(previousMonths('2026-01', 3)).toEqual(['2025-11', '2025-12', '2026-01']);
  });

  it('handles a single-month window', () => {
    expect(previousMonths('2026-07', 1)).toEqual(['2026-07']);
  });
});

describe('buildRunningCostsReport', () => {
  // A recurring hosting bill (ongoing), a recurring AI bill that ended in Feb,
  // and a one-off domain incidental in Feb.
  const entries: CostEntry[] = [
    entry({ kind: 'recurring', category: 'hosting', amountCents: 2000, startMonth: '2026-01', endMonth: null }),
    entry({ kind: 'recurring', category: 'ai', amountCents: 1000, startMonth: '2026-01', endMonth: '2026-02' }),
    entry({ kind: 'incidental', category: 'domain', amountCents: 500, startMonth: '2026-02', endMonth: null }),
  ];

  const report = buildRunningCostsReport(entries, 3, '2026-03');

  it('returns one row per month in the window, ascending', () => {
    expect(report.months.map((m) => m.month)).toEqual(['2026-01', '2026-02', '2026-03']);
  });

  it('sums recurring entries across their active window', () => {
    const jan = report.months[0];
    expect(jan.recurringCents).toBe(3000); // 2000 hosting + 1000 ai
    expect(jan.incidentalCents).toBe(0);
    expect(jan.totalCents).toBe(3000);
  });

  it('adds incidentals only to their own month', () => {
    const feb = report.months[1];
    expect(feb.recurringCents).toBe(3000);
    expect(feb.incidentalCents).toBe(500);
    expect(feb.totalCents).toBe(3500);
  });

  it('drops a recurring entry after its endMonth', () => {
    const mar = report.months[2];
    // Only the ongoing hosting bill remains; the AI bill ended in Feb.
    expect(mar.recurringCents).toBe(2000);
    expect(mar.incidentalCents).toBe(0);
    expect(mar.totalCents).toBe(2000);
  });

  it('exposes the latest month total for the headline', () => {
    expect(report.latestMonthlyTotalCents).toBe(2000);
  });

  it('breaks a month down by category, sorted by amount desc', () => {
    const feb = report.months[1];
    expect(feb.byCategory).toEqual([
      { category: 'hosting', amountCents: 2000 },
      { category: 'ai', amountCents: 1000 },
      { category: 'domain', amountCents: 500 },
    ]);
  });

  it('returns zeroed months when there are no entries', () => {
    const empty = buildRunningCostsReport([], 2, '2026-03');
    expect(empty.months).toHaveLength(2);
    expect(empty.months.every((m) => m.totalCents === 0 && m.byCategory.length === 0)).toBe(true);
    expect(empty.latestMonthlyTotalCents).toBe(0);
  });
});
