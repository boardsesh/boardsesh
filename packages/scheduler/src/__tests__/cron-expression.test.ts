import { describe, expect, it } from 'vitest';
import {
  CronExpressionError,
  isValidCronExpression,
  matchesCronExpression,
  parseCronExpression,
  type CronTimeFields,
} from '../cron/expression';
import { getZonedMinuteKey, getZonedTimeFields } from '../cron/zoned-time';

const at = (fields: Partial<CronTimeFields>): CronTimeFields => ({
  minute: 0,
  hour: 0,
  dayOfMonth: 1,
  month: 1,
  dayOfWeek: 0,
  ...fields,
});

describe('parseCronExpression', () => {
  it('parses the daily cleanup slot', () => {
    const expression = parseCronExpression('0 5 * * *');
    expect([...expression.minutes]).toEqual([0]);
    expect([...expression.hours]).toEqual([5]);
    expect(expression.restrictsDayOfMonth).toBe(false);
    expect(expression.restrictsDayOfWeek).toBe(false);
  });

  it('parses the weekly prewarm slots still owned by Vercel', () => {
    const expression = parseCronExpression('45 4 * * 0');
    expect([...expression.minutes]).toEqual([45]);
    expect([...expression.hours]).toEqual([4]);
    expect([...expression.daysOfWeek]).toEqual([0]);
    expect(expression.restrictsDayOfWeek).toBe(true);
  });

  it('expands steps, ranges and lists', () => {
    expect([...parseCronExpression('*/15 * * * *').minutes]).toEqual([0, 15, 30, 45]);
    expect([...parseCronExpression('0 9-11 * * *').hours]).toEqual([9, 10, 11]);
    expect([...parseCronExpression('0 0 * * 1,3,5').daysOfWeek]).toEqual([1, 3, 5]);
    expect([...parseCronExpression('0 0-23/6 * * *').hours]).toEqual([0, 6, 12, 18]);
    expect([...parseCronExpression('0 20/2 * * *').hours]).toEqual([20, 22]);
  });

  it('normalises day-of-week 7 to Sunday', () => {
    expect([...parseCronExpression('0 0 * * 7').daysOfWeek]).toEqual([0]);
  });

  it('rejects malformed expressions instead of guessing', () => {
    expect(() => parseCronExpression('0 5 * *')).toThrow(CronExpressionError);
    expect(() => parseCronExpression('0 5 * * * *')).toThrow(/exactly 5 fields/);
    expect(() => parseCronExpression('60 5 * * *')).toThrow(/out of range/);
    expect(() => parseCronExpression('0 5 * JAN *')).toThrow(CronExpressionError);
    expect(() => parseCronExpression('@daily')).toThrow(CronExpressionError);
    expect(() => parseCronExpression('0 9-5 * * *')).toThrow(/inverted/);
    expect(() => parseCronExpression('0 */0 * * *')).toThrow(/step must be >= 1/);
    expect(isValidCronExpression('0 5 * * *')).toBe(true);
    expect(isValidCronExpression('nonsense')).toBe(false);
  });
});

describe('matchesCronExpression', () => {
  it('matches only the declared minute of the declared hour', () => {
    const expression = parseCronExpression('0 5 * * *');
    expect(matchesCronExpression(expression, at({ hour: 5, minute: 0 }))).toBe(true);
    expect(matchesCronExpression(expression, at({ hour: 5, minute: 1 }))).toBe(false);
    expect(matchesCronExpression(expression, at({ hour: 4, minute: 0 }))).toBe(false);
  });

  it('applies OR semantics when both day fields are restricted', () => {
    const expression = parseCronExpression('0 0 13 * 5');
    expect(matchesCronExpression(expression, at({ dayOfMonth: 13, dayOfWeek: 2 }))).toBe(true);
    expect(matchesCronExpression(expression, at({ dayOfMonth: 4, dayOfWeek: 5 }))).toBe(true);
    expect(matchesCronExpression(expression, at({ dayOfMonth: 4, dayOfWeek: 2 }))).toBe(false);
  });

  it('applies AND semantics when only one day field is restricted', () => {
    const dayOfWeekOnly = parseCronExpression('0 4 * * 0');
    expect(matchesCronExpression(dayOfWeekOnly, at({ hour: 4, dayOfMonth: 17, dayOfWeek: 0 }))).toBe(true);
    expect(matchesCronExpression(dayOfWeekOnly, at({ hour: 4, dayOfMonth: 17, dayOfWeek: 1 }))).toBe(false);

    const dayOfMonthOnly = parseCronExpression('0 4 1 * *');
    expect(matchesCronExpression(dayOfMonthOnly, at({ hour: 4, dayOfMonth: 1, dayOfWeek: 3 }))).toBe(true);
    expect(matchesCronExpression(dayOfMonthOnly, at({ hour: 4, dayOfMonth: 2, dayOfWeek: 3 }))).toBe(false);
  });
});

describe('getZonedTimeFields', () => {
  it('resolves UTC fields independently of the host timezone', () => {
    // 2026-08-11T05:00:00Z is a Tuesday.
    const fields = getZonedTimeFields(new Date('2026-08-11T05:00:00Z'), 'UTC');
    expect(fields).toEqual({ minute: 0, hour: 5, dayOfMonth: 11, month: 8, dayOfWeek: 2 });
  });

  it('shifts the wall clock for a non-UTC zone', () => {
    const sydney = getZonedTimeFields(new Date('2026-08-11T05:00:00Z'), 'Australia/Sydney');
    expect(sydney.hour).toBe(15);
    expect(sydney.dayOfMonth).toBe(11);
  });

  it('produces a minute key that is stable within a minute and changes across minutes', () => {
    const firstKey = getZonedMinuteKey(new Date('2026-08-11T05:00:00Z'), 'UTC');
    const sameMinuteKey = getZonedMinuteKey(new Date('2026-08-11T05:00:59Z'), 'UTC');
    const nextMinuteKey = getZonedMinuteKey(new Date('2026-08-11T05:01:00Z'), 'UTC');
    expect(sameMinuteKey).toBe(firstKey);
    expect(nextMinuteKey).not.toBe(firstKey);
  });

  it('rejects an unknown timezone rather than silently using the host zone', () => {
    expect(() => getZonedTimeFields(new Date(), 'Mars/Olympus_Mons')).toThrow();
  });
});
