import { describe, expect, it } from 'vitest';
import { parseCronExpression } from '../cron/expression';
import { createPreviousRunFinder, PREVIOUS_RUN_SEARCH_MINUTES, previousScheduledRun } from '../cron/previous-run';

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

describe('createPreviousRunFinder', () => {
  const MINUTE_MS = 60_000;

  /** Asks the memoised finder and the plain walk the same questions, in order. */
  function expectSameAnswers(schedule: string, timeZone: string, instants: readonly Date[]) {
    const expression = parseCronExpression(schedule);
    const findPreviousRun = createPreviousRunFinder(expression, timeZone);
    for (const instant of instants) {
      expect(iso(findPreviousRun(instant)), `${schedule} at ${instant.toISOString()}`).toBe(
        iso(previousScheduledRun(expression, timeZone, instant)),
      );
    }
  }

  it('agrees with the full walk across two days of irregular polls', () => {
    const instants: Date[] = [];
    let currentMs = Date.parse('2026-09-19T23:58:17.000Z');
    // Steps of 7 s to 3 h: repeat hits within one minute, single-minute steps
    // and multi-hour jumps across slots all get exercised. Starts on a Saturday
    // night so the weekly Sunday 06:00 slot is crossed too.
    const stepsMs = [7_000, 53_000, MINUTE_MS, 11 * MINUTE_MS, 3 * 60 * MINUTE_MS, 29_000];
    for (let pollIndex = 0; pollIndex < 100; pollIndex += 1) {
      instants.push(new Date(currentMs));
      currentMs += stepsMs[pollIndex % stepsMs.length];
    }
    for (const schedule of ['0 5 * * *', '0 6 * * 0', '0 */6 * * *', '30 6 * * *', '0 7 * * *']) {
      expectSameAnswers(schedule, 'UTC', instants);
    }
  }, 30_000);

  it('agrees with the full walk when the clock jumps back or past the search bound', () => {
    expectSameAnswers('0 6 * * 0', 'UTC', [
      new Date('2026-09-23T12:00:00.000Z'),
      new Date('2026-09-21T12:00:00.000Z'),
      new Date('2026-10-10T12:00:00.000Z'),
    ]);
  });

  it('ages a monthly match out of the bound exactly like the full walk', () => {
    const instants: Date[] = [];
    for (let dayOffset = 0; dayOffset < 12; dayOffset += 1) {
      instants.push(new Date(Date.parse('2026-09-01T00:00:00.000Z') + dayOffset * 24 * 60 * MINUTE_MS));
    }
    // Minute-exact edge of the 8-day bound on either side.
    const boundMs = Date.parse('2026-09-01T00:00:00.000Z') + PREVIOUS_RUN_SEARCH_MINUTES * MINUTE_MS;
    instants.push(new Date(boundMs), new Date(boundMs + MINUTE_MS));
    instants.sort((left, right) => left.getTime() - right.getTime());
    expectSameAnswers('0 0 1 * *', 'UTC', instants);
  });

  it('agrees with the full walk through a fall-back hour', () => {
    const instants: Date[] = [];
    for (let minuteOffset = 0; minuteOffset < 4 * 60; minuteOffset += 1) {
      instants.push(new Date(Date.parse('2026-10-24T23:00:00.000Z') + minuteOffset * MINUTE_MS));
    }
    expectSameAnswers('30 1 * * *', 'Europe/London', instants);
  });
});
