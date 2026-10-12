import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_LOGBOOK_FILTERS, DEFAULT_LOGBOOK_SORT } from '../defaults';
import { isLogbookDateFilterActive, LOGBOOK_DATE_WINDOWS, resolveLogbookDateRange } from '../date-window';
import {
  logbookFiltersForStorage,
  MAX_LOGBOOK_SETTER_FILTERS,
  sanitizeLogbookFilters,
  sanitizeLogbookSort,
} from '../sanitize';
import { LOGBOOK_SORT_KEYS, logbookSortFor, logbookSortKeyOf } from '../sort-keys';
import { filtersForStatusSegment, LOGBOOK_STATUS_SEGMENTS, statusSegmentFor } from '../status-segments';
import { toAscentFeedInput } from '../to-ascent-feed-input';
import type {
  LogbookDateWindow,
  LogbookFilterState,
  LogbookSortDirection,
  LogbookSortKey,
  LogbookSortState,
} from '../types';

const withFilters = (overrides: Partial<LogbookFilterState>): LogbookFilterState => ({
  ...DEFAULT_LOGBOOK_FILTERS,
  ...overrides,
});

// A fixed LOCAL clock: built from local parts so the expectations hold in any
// test-runner timezone.
const localDate = (year: number, month: number, day: number, hour = 12, minute = 0) =>
  new Date(year, month - 1, day, hour, minute);

describe('status segments', () => {
  it('round-trips every segment through the stored fields', () => {
    for (const segment of LOGBOOK_STATUS_SEGMENTS) {
      expect(statusSegmentFor(filtersForStatusSegment(segment))).toBe(segment);
    }
  });

  it('writes the stored triple each segment means', () => {
    expect(filtersForStatusSegment('all')).toEqual({ includeSends: true, includeAttempts: true, flashOnly: false });
    expect(filtersForStatusSegment('sends')).toEqual({ includeSends: true, includeAttempts: false, flashOnly: false });
    expect(filtersForStatusSegment('flashes')).toEqual({ includeSends: true, includeAttempts: false, flashOnly: true });
    expect(filtersForStatusSegment('attempts')).toEqual({
      includeSends: false,
      includeAttempts: true,
      flashOnly: false,
    });
  });

  it('reads an old stored "both + flash only" as Flashes', () => {
    expect(statusSegmentFor({ includeSends: true, includeAttempts: true, flashOnly: true })).toBe('flashes');
  });

  it('reads attempts-only as Attempts even with a stray flashOnly', () => {
    expect(statusSegmentFor({ includeSends: false, includeAttempts: true, flashOnly: true })).toBe('attempts');
  });

  it('reads the impossible neither-on state the way the sanitizer repairs it', () => {
    const neither = { includeSends: false, includeAttempts: false, flashOnly: false };
    expect(sanitizeLogbookFilters(neither)).toMatchObject({ includeSends: true, includeAttempts: false });
    expect(statusSegmentFor(neither)).toBe('sends');
    expect(statusSegmentFor({ ...neither, flashOnly: true })).toBe('flashes');
    expect(statusSegmentFor(sanitizeLogbookFilters({ ...neither, flashOnly: true }))).toBe('flashes');
  });

  it('the feed input queries the neither-on state as Sends / Flashes too', () => {
    const neither = withFilters({ includeSends: false, includeAttempts: false, flashOnly: false });
    expect(toAscentFeedInput({ filters: neither, sort: DEFAULT_LOGBOOK_SORT })).toMatchObject({
      statusMode: 'send',
      flashOnly: false,
    });
    expect(toAscentFeedInput({ filters: { ...neither, flashOnly: true }, sort: DEFAULT_LOGBOOK_SORT })).toMatchObject({
      statusMode: 'send',
      flashOnly: true,
    });
  });

  it('defaults read as All', () => {
    expect(statusSegmentFor(DEFAULT_LOGBOOK_FILTERS)).toBe('all');
  });

  it('each segment produces the feed status it means', () => {
    const feedFor = (segment: (typeof LOGBOOK_STATUS_SEGMENTS)[number]) =>
      toAscentFeedInput({ filters: withFilters(filtersForStatusSegment(segment)), sort: DEFAULT_LOGBOOK_SORT });
    expect(feedFor('all')).toMatchObject({ statusMode: 'both', flashOnly: false });
    expect(feedFor('sends')).toMatchObject({ statusMode: 'send', flashOnly: false });
    expect(feedFor('flashes')).toMatchObject({ statusMode: 'send', flashOnly: true });
    expect(feedFor('attempts')).toMatchObject({ statusMode: 'attempt', flashOnly: false });
  });
});

describe('resolveLogbookDateRange', () => {
  const rangeFor = (dateWindow: LogbookDateWindow, now: Date, overrides: Partial<LogbookFilterState> = {}) =>
    resolveLogbookDateRange(withFilters({ dateWindow, ...overrides }), now);

  it('any is open on both sides, even with a stored custom range', () => {
    expect(rangeFor('any', localDate(2026, 10, 12), { fromDate: '2026-01-01', toDate: '2026-02-01' })).toEqual({
      fromDate: '',
      toDate: '',
    });
  });

  it('custom passes the stored range through', () => {
    expect(rangeFor('custom', localDate(2026, 10, 12), { fromDate: '2026-01-01', toDate: '2026-02-01' })).toEqual({
      fromDate: '2026-01-01',
      toDate: '2026-02-01',
    });
    expect(rangeFor('custom', localDate(2026, 10, 12), { fromDate: '2026-01-01' })).toEqual({
      fromDate: '2026-01-01',
      toDate: '',
    });
  });

  it('last7 = today and the six days before', () => {
    expect(rangeFor('last7', localDate(2026, 10, 12))).toEqual({ fromDate: '2026-10-06', toDate: '2026-10-12' });
    // Crosses a month and a year boundary.
    expect(rangeFor('last7', localDate(2026, 3, 3))).toEqual({ fromDate: '2026-02-25', toDate: '2026-03-03' });
    expect(rangeFor('last7', localDate(2026, 1, 2))).toEqual({ fromDate: '2025-12-27', toDate: '2026-01-02' });
  });

  it('month = the 1st of this calendar month to today', () => {
    expect(rangeFor('month', localDate(2026, 10, 12))).toEqual({ fromDate: '2026-10-01', toDate: '2026-10-12' });
    expect(rangeFor('month', localDate(2026, 10, 1))).toEqual({ fromDate: '2026-10-01', toDate: '2026-10-01' });
    expect(rangeFor('month', localDate(2026, 12, 31))).toEqual({ fromDate: '2026-12-01', toDate: '2026-12-31' });
  });

  it('last3months = the same day three months ago, clamped to short months', () => {
    expect(rangeFor('last3months', localDate(2026, 10, 12))).toEqual({
      fromDate: '2026-07-12',
      toDate: '2026-10-12',
    });
    // Crosses the year.
    expect(rangeFor('last3months', localDate(2026, 1, 15))).toEqual({
      fromDate: '2025-10-15',
      toDate: '2026-01-15',
    });
    // May 31 -> Feb 28 (2026) and Feb 29 (leap 2024), never March.
    expect(rangeFor('last3months', localDate(2026, 5, 31))).toEqual({
      fromDate: '2026-02-28',
      toDate: '2026-05-31',
    });
    expect(rangeFor('last3months', localDate(2024, 5, 31))).toEqual({
      fromDate: '2024-02-29',
      toDate: '2024-05-31',
    });
  });

  it('year = Jan 1 to today', () => {
    expect(rangeFor('year', localDate(2026, 10, 12))).toEqual({ fromDate: '2026-01-01', toDate: '2026-10-12' });
    expect(rangeFor('year', localDate(2026, 1, 1))).toEqual({ fromDate: '2026-01-01', toDate: '2026-01-01' });
  });

  it('rolling windows ignore a stored custom range', () => {
    expect(rangeFor('month', localDate(2026, 10, 12), { fromDate: '2020-01-01', toDate: '2020-02-01' })).toEqual({
      fromDate: '2026-10-01',
      toDate: '2026-10-12',
    });
  });

  it('rolls forward with the clock: "This month" next month is next month', () => {
    expect(rangeFor('month', localDate(2026, 11, 3)).fromDate).toBe('2026-11-01');
  });

  describe('in a timezone west of UTC', () => {
    const originalTz = process.env.TZ;
    afterEach(() => {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    });

    it('cuts the day on the device calendar, not UTC', () => {
      process.env.TZ = 'America/Los_Angeles';
      // 23:30 on Oct 31 in Los Angeles is already Nov 1 in UTC.
      const lateEvening = localDate(2026, 10, 31, 23, 30);
      expect(lateEvening.getUTCDate()).toBe(1);
      expect(rangeFor('month', lateEvening)).toEqual({ fromDate: '2026-10-01', toDate: '2026-10-31' });
    });
  });
});

describe('isLogbookDateFilterActive', () => {
  it('is off for Any time and for a Custom window with nothing picked', () => {
    expect(isLogbookDateFilterActive(DEFAULT_LOGBOOK_FILTERS)).toBe(false);
    expect(isLogbookDateFilterActive(withFilters({ dateWindow: 'custom' }))).toBe(false);
    // A leftover range under Any time narrows nothing.
    expect(isLogbookDateFilterActive(withFilters({ dateWindow: 'any', fromDate: '2026-01-01' }))).toBe(false);
  });

  it('is on for every rolling window and a Custom window with a bound', () => {
    for (const dateWindow of LOGBOOK_DATE_WINDOWS.filter((window) => window !== 'any' && window !== 'custom')) {
      expect(isLogbookDateFilterActive(withFilters({ dateWindow }))).toBe(true);
    }
    expect(isLogbookDateFilterActive(withFilters({ dateWindow: 'custom', toDate: '2026-02-01' }))).toBe(true);
  });
});

describe('toAscentFeedInput date windows', () => {
  const now = localDate(2026, 10, 12);

  it('omits dates for Any time, even with a leftover custom range', () => {
    const input = toAscentFeedInput({
      filters: withFilters({ dateWindow: 'any', fromDate: '2026-01-01', toDate: '2026-02-01' }),
      sort: DEFAULT_LOGBOOK_SORT,
      now,
    });
    expect(input.fromDate).toBeUndefined();
    expect(input.toDate).toBeUndefined();
  });

  it('a rolling window sends local midnight of its first day and no upper bound', () => {
    const input = toAscentFeedInput({ filters: withFilters({ dateWindow: 'last7' }), sort: DEFAULT_LOGBOOK_SORT, now });
    expect(input.fromDate).toBe(new Date(2026, 9, 6).toISOString());
    expect(input).not.toHaveProperty('toDate');
  });

  it('Custom sends both bounds', () => {
    const input = toAscentFeedInput({
      filters: withFilters({ dateWindow: 'custom', fromDate: '2026-01-01', toDate: '2026-02-01' }),
      sort: DEFAULT_LOGBOOK_SORT,
      now,
    });
    expect(input.fromDate).toBe(new Date(2026, 0, 1).toISOString());
    // Exclusive: local midnight of the day AFTER the To day.
    expect(input.toDate).toBe(new Date(2026, 1, 2).toISOString());
  });

  it('Custom with one bound sends only that bound', () => {
    const fromOnly = toAscentFeedInput({
      filters: withFilters({ dateWindow: 'custom', fromDate: '2026-01-01' }),
      sort: DEFAULT_LOGBOOK_SORT,
      now,
    });
    expect(fromOnly.fromDate).toBe(new Date(2026, 0, 1).toISOString());
    expect(fromOnly).not.toHaveProperty('toDate');
    const toOnly = toAscentFeedInput({
      filters: withFilters({ dateWindow: 'custom', toDate: '2026-12-31' }),
      sort: DEFAULT_LOGBOOK_SORT,
      now,
    });
    expect(toOnly).not.toHaveProperty('fromDate');
    expect(toOnly.toDate).toBe(new Date(2027, 0, 1).toISOString());
  });

  it('drops an impossible in-memory date instead of sending it', () => {
    const input = toAscentFeedInput({
      filters: withFilters({ dateWindow: 'custom', fromDate: '2026-02-30', toDate: 'soon' }),
      sort: DEFAULT_LOGBOOK_SORT,
      now,
    });
    expect(input).not.toHaveProperty('fromDate');
    expect(input).not.toHaveProperty('toDate');
  });

  it('resolves against the real clock when no `now` is passed', () => {
    const today = new Date();
    const input = toAscentFeedInput({ filters: withFilters({ dateWindow: 'year' }), sort: DEFAULT_LOGBOOK_SORT });
    expect(input.fromDate).toBe(new Date(today.getFullYear(), 0, 1).toISOString());
  });

  describe('on the device calendar in real timezones', () => {
    const originalTz = process.env.TZ;
    afterEach(() => {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    });
    const feedFor = (filters: Partial<LogbookFilterState>, clock: Date) =>
      toAscentFeedInput({ filters: withFilters(filters), sort: DEFAULT_LOGBOOK_SORT, now: clock });

    it('Auckland (UTC+13): "This month" at 00:30 on Oct 1 starts at local midnight', () => {
      process.env.TZ = 'Pacific/Auckland';
      const input = feedFor({ dateWindow: 'month' }, localDate(2026, 10, 1, 0, 30));
      expect(input.fromDate).toBe('2026-09-30T11:00:00.000Z');
      // A tick logged at 00:15 local on Oct 1 is inside the window. As a bare
      // '2026-10-01' (a UTC day) it would have been cut.
      const tickAt = localDate(2026, 10, 1, 0, 15).toISOString();
      expect(tickAt).toBe('2026-09-30T11:15:00.000Z');
      expect(tickAt >= (input.fromDate ?? '')).toBe(true);
    });

    it('Los Angeles (UTC-7): "This month" starts at 07:00Z', () => {
      process.env.TZ = 'America/Los_Angeles';
      expect(feedFor({ dateWindow: 'month' }, localDate(2026, 10, 31, 23, 30)).fromDate).toBe(
        '2026-10-01T07:00:00.000Z',
      );
    });

    it('Custom ends at the exclusive local midnight after the To day', () => {
      process.env.TZ = 'America/Los_Angeles';
      const input = feedFor({ dateWindow: 'custom', fromDate: '2026-06-01', toDate: '2026-06-30' }, now);
      expect(input.fromDate).toBe('2026-06-01T07:00:00.000Z');
      expect(input.toDate).toBe('2026-07-01T07:00:00.000Z');
    });

    it('a DST day keeps its real length (23 h in spring, 25 h in autumn)', () => {
      process.env.TZ = 'America/Los_Angeles';
      const spring = feedFor({ dateWindow: 'custom', fromDate: '2026-03-08', toDate: '2026-03-08' }, now);
      expect(spring.fromDate).toBe('2026-03-08T08:00:00.000Z');
      expect(spring.toDate).toBe('2026-03-09T07:00:00.000Z');
      const autumn = feedFor({ dateWindow: 'custom', fromDate: '2026-11-01', toDate: '2026-11-01' }, now);
      expect(autumn.fromDate).toBe('2026-11-01T07:00:00.000Z');
      expect(autumn.toDate).toBe('2026-11-02T08:00:00.000Z');
      // A rolling window that reaches back across the change starts in PST.
      expect(feedFor({ dateWindow: 'last7' }, localDate(2026, 3, 10)).fromDate).toBe('2026-03-04T08:00:00.000Z');
    });
  });
});

describe('toAscentFeedInput board, stars and setters', () => {
  it('omits every new filter at its default (stable key, old backends unaffected)', () => {
    const input = toAscentFeedInput({ filters: DEFAULT_LOGBOOK_FILTERS, sort: DEFAULT_LOGBOOK_SORT });
    expect(input).toEqual({ statusMode: 'both', flashOnly: false, sortBy: 'recent', sortOrder: 'desc' });
  });

  it('sends the stored board and its layouts', () => {
    const input = toAscentFeedInput({
      filters: withFilters({ boardType: 'kilter', layoutIds: [1, 8] }),
      sort: DEFAULT_LOGBOOK_SORT,
    });
    expect(input.boardType).toBe('kilter');
    expect(input.layoutIds).toEqual([1, 8]);
    expect(input.boardTypes).toBeUndefined();
  });

  it('never sends layouts without a board', () => {
    const input = toAscentFeedInput({ filters: withFilters({ layoutIds: [1] }), sort: DEFAULT_LOGBOOK_SORT });
    expect(input.layoutIds).toBeUndefined();
    expect(input.boardType).toBeUndefined();
  });

  it('explicit board args (screenshot mode) replace the stored board scope', () => {
    const input = toAscentFeedInput({
      filters: withFilters({ boardType: 'kilter', layoutIds: [1, 8] }),
      sort: DEFAULT_LOGBOOK_SORT,
      boardTypes: ['tension'],
    });
    expect(input.boardType).toBe('tension');
    expect(input.layoutIds).toBeUndefined();
  });

  it('an empty explicit board list falls back to the stored board', () => {
    const input = toAscentFeedInput({
      filters: withFilters({ boardType: 'kilter' }),
      sort: DEFAULT_LOGBOOK_SORT,
      boardTypes: [],
    });
    expect(input.boardType).toBe('kilter');
  });

  it('sends minQuality and setterUsernames only when set', () => {
    const input = toAscentFeedInput({
      filters: withFilters({ minQuality: 3, setterUsernames: ['jwebb', 'alex'] }),
      sort: DEFAULT_LOGBOOK_SORT,
    });
    expect(input.minQuality).toBe(3);
    expect(input.setterUsernames).toEqual(['jwebb', 'alex']);
  });
});

describe('sort keys', () => {
  const combos: Array<[LogbookSortKey, LogbookSortDirection]> = LOGBOOK_SORT_KEYS.flatMap((key) =>
    (['desc', 'asc'] as const).map((direction): [LogbookSortKey, LogbookSortDirection] => [key, direction]),
  );

  it('covers all ten key x order combinations', () => {
    expect(combos).toHaveLength(10);
  });

  it.each(combos)('%s %s round-trips through the stored sort', (key, direction) => {
    const sort = logbookSortFor(key, direction);
    expect(logbookSortKeyOf(sort)).toEqual({ key, direction });
    // The stored shape survives the sanitizer unchanged (persistable).
    expect(sanitizeLogbookSort(sort)).toEqual(sort);
  });

  const expectedFeedSort: Record<string, Record<string, unknown>> = {
    'date desc': { sortBy: 'recent', sortOrder: 'desc' },
    'date asc': { sortBy: 'date', sortOrder: 'asc' },
    'grade desc': { sortBy: 'hardest', sortOrder: 'desc' },
    'grade asc': { sortBy: 'easiest', sortOrder: 'asc' },
    'loggedGrade desc': {
      sortBy: 'loggedGrade',
      sortOrder: 'desc',
      secondarySortBy: 'date',
      secondarySortOrder: 'desc',
    },
    'loggedGrade asc': { sortBy: 'loggedGrade', sortOrder: 'asc', secondarySortBy: 'date', secondarySortOrder: 'desc' },
    'climbName desc': { sortBy: 'climbName', sortOrder: 'desc', secondarySortBy: 'date', secondarySortOrder: 'desc' },
    'climbName asc': { sortBy: 'climbName', sortOrder: 'asc', secondarySortBy: 'date', secondarySortOrder: 'desc' },
    'attemptCount desc': {
      sortBy: 'attemptCount',
      sortOrder: 'desc',
      secondarySortBy: 'date',
      secondarySortOrder: 'desc',
    },
    'attemptCount asc': {
      sortBy: 'attemptCount',
      sortOrder: 'asc',
      secondarySortBy: 'date',
      secondarySortOrder: 'desc',
    },
  };

  it.each(combos)('%s %s produces the expected feed sort', (key, direction) => {
    const input = toAscentFeedInput({ filters: DEFAULT_LOGBOOK_FILTERS, sort: logbookSortFor(key, direction) });
    const { sortBy, sortOrder, secondarySortBy, secondarySortOrder } = input;
    const actual = Object.fromEntries(
      Object.entries({ sortBy, sortOrder, secondarySortBy, secondarySortOrder }).filter(
        ([, entry]) => entry !== undefined,
      ),
    );
    expect(actual).toEqual(expectedFeedSort[`${key} ${direction}`]);
  });

  it('the default sort reads as Date desc', () => {
    expect(logbookSortKeyOf(DEFAULT_LOGBOOK_SORT)).toEqual({ key: 'date', direction: 'desc' });
    expect(logbookSortFor('date', 'desc')).toEqual(DEFAULT_LOGBOOK_SORT);
  });

  it('maps an older custom consensus-grade sort to Grade, keeping its order', () => {
    const legacy: LogbookSortState = {
      mode: 'custom',
      preset: 'recent',
      primaryField: 'consensusGrade',
      primaryDirection: 'asc',
      secondaryField: '',
      secondaryDirection: 'desc',
    };
    expect(logbookSortKeyOf(legacy)).toEqual({ key: 'grade', direction: 'asc' });
  });

  it('maps an unknown primary field to Date desc', () => {
    const corrupt = { ...DEFAULT_LOGBOOK_SORT, mode: 'custom', primaryField: 'bogus' } as unknown as LogbookSortState;
    expect(logbookSortKeyOf(corrupt)).toEqual({ key: 'date', direction: 'desc' });
  });
});

describe('sanitizeLogbookFilters back-compat and new fields', () => {
  // What a v4 mobile build (or the current web build) persisted: no window,
  // board, stars or setters.
  const v4Filters = {
    includeSends: true,
    includeAttempts: false,
    flashOnly: false,
    minGrade: 12,
    maxGrade: '',
    fromDate: '2026-03-01',
    toDate: '2026-04-01',
    angleRange: [20, 50],
    benchmarkOnly: true,
  };

  it('reads a v4 payload with a picked range as Custom, keeping every old field', () => {
    expect(sanitizeLogbookFilters(v4Filters)).toEqual({
      ...v4Filters,
      dateWindow: 'custom',
      boardType: '',
      layoutIds: [],
      minQuality: '',
      setterUsernames: [],
    });
  });

  it('reads a v4 payload without dates as Any time', () => {
    expect(sanitizeLogbookFilters({ ...v4Filters, fromDate: '', toDate: '' }).dateWindow).toBe('any');
  });

  it('an invalid window falls back the same way (Custom when a range exists)', () => {
    expect(sanitizeLogbookFilters({ ...v4Filters, dateWindow: 'fortnight' }).dateWindow).toBe('custom');
    expect(sanitizeLogbookFilters({ dateWindow: 'fortnight' }).dateWindow).toBe('any');
  });

  it('keeps every valid window', () => {
    for (const dateWindow of LOGBOOK_DATE_WINDOWS) {
      expect(sanitizeLogbookFilters({ dateWindow }).dateWindow).toBe(dateWindow);
    }
  });

  it('heals an inverted custom range', () => {
    const healed = sanitizeLogbookFilters({ dateWindow: 'custom', fromDate: '2026-05-01', toDate: '2026-01-01' });
    expect(healed.fromDate).toBe('2026-01-01');
    expect(healed.toDate).toBe('2026-05-01');
  });

  it('clamps stars to whole 1-5 and drops non-numbers', () => {
    expect(sanitizeLogbookFilters({ minQuality: 3 }).minQuality).toBe(3);
    expect(sanitizeLogbookFilters({ minQuality: 9 }).minQuality).toBe(5);
    expect(sanitizeLogbookFilters({ minQuality: 0 }).minQuality).toBe(1);
    expect(sanitizeLogbookFilters({ minQuality: 3.6 }).minQuality).toBe(4);
    expect(sanitizeLogbookFilters({ minQuality: '3' }).minQuality).toBe('');
    expect(sanitizeLogbookFilters({ minQuality: Number.NaN }).minQuality).toBe('');
  });

  it('trims, dedupes and caps setters', () => {
    expect(sanitizeLogbookFilters({ setterUsernames: [' jwebb ', 'jwebb', '', 7, 'alex'] }).setterUsernames).toEqual([
      'jwebb',
      'alex',
    ]);
    const many = Array.from({ length: 30 }, (_, index) => `setter${index}`);
    const capped = sanitizeLogbookFilters({ setterUsernames: many }).setterUsernames;
    expect(capped).toHaveLength(MAX_LOGBOOK_SETTER_FILTERS);
    expect(capped[0]).toBe('setter0');
    expect(sanitizeLogbookFilters({ setterUsernames: 'jwebb' }).setterUsernames).toEqual([]);
  });

  it('keeps positive whole layout ids under a board, deduped and ascending', () => {
    expect(sanitizeLogbookFilters({ boardType: 'kilter', layoutIds: [8, 1, 8, -2, 0, 1.5, '3'] }).layoutIds).toEqual([
      1, 8,
    ]);
  });

  it('drops layouts without a board, and junk board types', () => {
    expect(sanitizeLogbookFilters({ layoutIds: [1] }).layoutIds).toEqual([]);
    const junk = sanitizeLogbookFilters({ boardType: 'Kilter Board!', layoutIds: [1] });
    expect(junk.boardType).toBe('');
    expect(junk.layoutIds).toEqual([]);
    expect(sanitizeLogbookFilters({ boardType: 42 }).boardType).toBe('');
    // Board-shaped but not a board the app knows (the backend would reject it).
    expect(sanitizeLogbookFilters({ boardType: 'notaboard' }).boardType).toBe('');
  });

  it('keeps every supported board type', () => {
    for (const boardType of [
      'kilter',
      'tension',
      'moonboard',
      'decoy',
      'touchstone',
      'grasshopper',
      'soill',
      'woods',
      'spray',
    ]) {
      expect(sanitizeLogbookFilters({ boardType }).boardType).toBe(boardType);
    }
  });

  it('is idempotent on a fully populated state', () => {
    const full = withFilters({
      dateWindow: 'last3months',
      boardType: 'tension',
      layoutIds: [9, 10],
      minQuality: 4,
      setterUsernames: ['alex'],
    });
    expect(sanitizeLogbookFilters(full)).toEqual(full);
  });
});

describe('sanitizeLogbookSort presets', () => {
  it('keeps the easiest preset', () => {
    expect(sanitizeLogbookSort({ mode: 'preset', preset: 'easiest' }).preset).toBe('easiest');
  });
});

describe('logbookFiltersForStorage', () => {
  it('blanks a leftover range under every non-Custom window', () => {
    for (const dateWindow of LOGBOOK_DATE_WINDOWS.filter((window) => window !== 'custom')) {
      const stored = logbookFiltersForStorage(
        withFilters({ dateWindow, fromDate: '2026-01-01', toDate: '2026-02-01', minGrade: 12 }),
      );
      expect(stored).toMatchObject({ dateWindow, fromDate: '', toDate: '', minGrade: 12 });
    }
  });

  it('keeps the range under Custom', () => {
    const custom = withFilters({ dateWindow: 'custom', fromDate: '2026-01-01', toDate: '2026-02-01' });
    expect(logbookFiltersForStorage(custom)).toEqual(custom);
  });
});
