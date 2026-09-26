import { describe, expect, it } from 'vitest';
import { parseCronExpression } from '../cron/expression';
import { PREVIOUS_RUN_SEARCH_MINUTES, previousScheduledRun } from '../cron/previous-run';

const iso = (instant: Date | null) => instant?.toISOString() ?? null;

describe('previousScheduledRun', () => {
  it('returns today’s slot for a daily job just after it fired', () => {
    const daily = parseCronExpression('0 5 * * *');
    expect(iso(previousScheduledRun(daily, 'UTC', new Date('2026-09-26T05:00:42.000Z')))).toBe(
      '2026-09-26T05:00:00.000Z',
    );
    expect(iso(previousScheduledRun(daily, 'UTC', new Date('2026-09-26T05:01:00.000Z')))).toBe(
      '2026-09-26T05:00:00.000Z',
    );
  });

  it('returns yesterday’s slot for a daily job just before it fires', () => {
    const daily = parseCronExpression('0 5 * * *');
    expect(iso(previousScheduledRun(daily, 'UTC', new Date('2026-09-26T04:59:59.999Z')))).toBe(
      '2026-09-25T05:00:00.000Z',
    );
  });

  it('returns last Sunday for a weekly job checked mid-week', () => {
    // 2026-09-23 is a Wednesday; the previous Sunday 06:00 UTC is 2026-09-20.
    const weekly = parseCronExpression('0 6 * * 0');
    expect(iso(previousScheduledRun(weekly, 'UTC', new Date('2026-09-23T12:00:00.000Z')))).toBe(
      '2026-09-20T06:00:00.000Z',
    );
  });

  it('returns the most recent six-hour slot', () => {
    const sixHourly = parseCronExpression('0 */6 * * *');
    expect(iso(previousScheduledRun(sixHourly, 'UTC', new Date('2026-09-26T17:59:00.000Z')))).toBe(
      '2026-09-26T12:00:00.000Z',
    );
  });

  it('skips a slot that falls in a spring-forward gap, like the ticker does', () => {
    // Europe/London jumps 01:00 GMT -> 02:00 BST on 2026-03-29, so 01:30 does
    // not exist that day; the last real 01:30 was 2026-03-28 01:30 GMT.
    const insideGap = parseCronExpression('30 1 * * *');
    expect(iso(previousScheduledRun(insideGap, 'Europe/London', new Date('2026-03-29T12:00:00.000Z')))).toBe(
      '2026-03-28T01:30:00.000Z',
    );
  });

  it('returns the first of a repeated fall-back minute, the one the ticker fires', () => {
    // Europe/London repeats 01:00-01:59 on 2026-10-25: 01:30 BST (00:30Z) then
    // 01:30 GMT (01:30Z). The ticker fires only the first.
    const repeated = parseCronExpression('30 1 * * *');
    expect(iso(previousScheduledRun(repeated, 'Europe/London', new Date('2026-10-25T12:00:00.000Z')))).toBe(
      '2026-10-25T00:30:00.000Z',
    );
  });

  it('returns null when nothing matches within the 8-day bound', () => {
    expect(PREVIOUS_RUN_SEARCH_MINUTES).toBe(11_520);
    // Monthly on the 1st, checked on the 20th: 19 days back is past the bound.
    const monthly = parseCronExpression('0 0 1 * *');
    expect(previousScheduledRun(monthly, 'UTC', new Date('2026-09-20T00:00:00.000Z'))).toBeNull();
  });
});
