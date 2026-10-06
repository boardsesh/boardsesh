import { describe, expect, it } from 'vitest';
import { formatSprayArchiveDate } from '../spray-archive-date';

describe('formatSprayArchiveDate', () => {
  // Noon UTC is still 1 October from UTC-11 to UTC+11, so the expectation does
  // not depend on the time zone of the machine running it. (09:00 UTC was the
  // previous day at UTC-10 and further west.)
  it('says the day a wall was archived in the reader’s language', () => {
    expect(formatSprayArchiveDate('2026-10-01T12:00:00.000Z', 'en-US')).toBe('Oct 1, 2026');
    expect(formatSprayArchiveDate('2026-10-01T12:00:00.000Z', 'de')).toBe('1. Okt. 2026');
  });

  // Every caller has a sentence without the date, so nothing is guessed.
  it.each([null, undefined, '', 'not a date'])('answers null for %j', (value) => {
    expect(formatSprayArchiveDate(value, 'en-US')).toBeNull();
  });
});
