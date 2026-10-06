import { describe, expect, it } from 'vitest';
import { formatSprayArchiveDate } from '../spray-archive-date';

describe('formatSprayArchiveDate', () => {
  it('says the day a wall was archived in the reader’s language', () => {
    expect(formatSprayArchiveDate('2026-10-01T09:00:00.000Z', 'en-US')).toBe('Oct 1, 2026');
    expect(formatSprayArchiveDate('2026-10-01T09:00:00.000Z', 'de')).toBe('1. Okt. 2026');
  });

  // Every caller has a sentence without the date, so nothing is guessed.
  it.each([null, undefined, '', 'not a date'])('answers null for %j', (value) => {
    expect(formatSprayArchiveDate(value, 'en-US')).toBeNull();
  });
});
