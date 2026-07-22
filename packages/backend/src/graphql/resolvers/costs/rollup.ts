import type { CostEntry } from '@boardsesh/db/schema';

/**
 * Pure monthly rollup for the public running-cost report. Kept free of any DB or
 * clock dependency so it can be unit-tested directly: callers pass the full set
 * of cost entries, the window size, and the "current" month key.
 */

export type CostCategoryAmount = { category: string; amountCents: number };

export type RunningCostsMonth = {
  month: string;
  totalCents: number;
  recurringCents: number;
  incidentalCents: number;
  byCategory: CostCategoryAmount[];
};

export type RunningCostsReport = {
  currency: string;
  months: RunningCostsMonth[];
  latestMonthlyTotalCents: number;
};

/** 'YYYY-MM' for a Date, in UTC. */
export function monthKeyFromDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/** The current month key in UTC. The only clock-dependent function here. */
export function currentMonthKey(): string {
  return monthKeyFromDate(new Date());
}

/** `count` consecutive month keys ending at (and including) `current`, ascending. */
export function previousMonths(current: string, count: number): string[] {
  const [year, month] = current.split('-').map(Number);
  const keys: string[] = [];
  for (let offset = count - 1; offset >= 0; offset--) {
    keys.push(monthKeyFromDate(new Date(Date.UTC(year, month - 1 - offset, 1))));
  }
  return keys;
}

/** Whether an entry contributes to a given month. */
function activeInMonth(entry: CostEntry, month: string): boolean {
  if (entry.kind === 'incidental') {
    return entry.startMonth === month;
  }
  // Recurring: active from startMonth through endMonth (inclusive), or forever
  // while endMonth is null.
  if (entry.startMonth > month) return false;
  if (entry.endMonth != null && entry.endMonth < month) return false;
  return true;
}

export function buildRunningCostsReport(
  entries: CostEntry[],
  windowMonths: number,
  currentMonth: string,
): RunningCostsReport {
  const months = previousMonths(currentMonth, windowMonths).map((month) => {
    let recurringCents = 0;
    let incidentalCents = 0;
    const byCategory = new Map<string, number>();

    for (const entry of entries) {
      if (!activeInMonth(entry, month)) continue;
      if (entry.kind === 'recurring') {
        recurringCents += entry.amountCents;
      } else {
        incidentalCents += entry.amountCents;
      }
      byCategory.set(entry.category, (byCategory.get(entry.category) ?? 0) + entry.amountCents);
    }

    return {
      month,
      totalCents: recurringCents + incidentalCents,
      recurringCents,
      incidentalCents,
      byCategory: [...byCategory.entries()]
        .map(([category, amountCents]) => ({ category, amountCents }))
        .sort((a, b) => b.amountCents - a.amountCents),
    };
  });

  const latest = months[months.length - 1];

  return {
    // Single-currency assumption for now (all bills are USD). Mixed currencies
    // would need per-currency rollups; noted as a limitation.
    currency: 'USD',
    months,
    latestMonthlyTotalCents: latest ? latest.totalCents : 0,
  };
}
