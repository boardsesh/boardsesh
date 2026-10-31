import { describe, expect, it } from 'vite-plus/test';
import { MAX_SUPPORTER_GRANT_MONTHS, parseGrantMonths, supporterGrantUntil } from '../supporter-grant';

describe('parseGrantMonths', () => {
  it('accepts whole months from 1 to the cap', () => {
    expect(parseGrantMonths('1')).toBe(1);
    expect(parseGrantMonths(' 12 ')).toBe(12);
    expect(parseGrantMonths(String(MAX_SUPPORTER_GRANT_MONTHS))).toBe(MAX_SUPPORTER_GRANT_MONTHS);
  });

  it('refuses zero, negatives, fractions, text and anything past the cap', () => {
    for (const raw of ['0', '-1', '1.5', 'abc', '', String(MAX_SUPPORTER_GRANT_MONTHS + 1)]) {
      expect(parseGrantMonths(raw)).toBeNull();
    }
  });
});

describe('supporterGrantUntil', () => {
  it('adds calendar months in UTC and keeps the time of day', () => {
    expect(supporterGrantUntil(new Date('2026-10-31T09:15:00.000Z'), 3).toISOString()).toBe('2027-01-31T09:15:00.000Z');
  });

  it('lands on the last day of a shorter month, like the backend credit rule', () => {
    expect(supporterGrantUntil(new Date('2027-01-31T00:00:00.000Z'), 1).toISOString()).toBe('2027-02-28T00:00:00.000Z');
    expect(supporterGrantUntil(new Date('2028-01-31T00:00:00.000Z'), 1).toISOString()).toBe('2028-02-29T00:00:00.000Z');
  });
});
