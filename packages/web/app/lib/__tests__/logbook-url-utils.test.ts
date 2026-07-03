import { describe, it, expect } from 'vite-plus/test';
import { readFiltersFromQuery, readSortFromQuery, filtersToQueryParams } from '../logbook-url-utils';
import { parseQueryParamBoolean, parseQueryParamInt } from '../url-utils';
import { DEFAULT_FILTERS, DEFAULT_SORT, DEFAULT_ANGLE_RANGE } from '../logbook-preferences';

// ---------- Shared helpers (parseQueryParamBoolean / parseQueryParamInt) ----------

describe('parseQueryParamBoolean', () => {
  it('returns true for "1"', () => {
    expect(parseQueryParamBoolean(new URLSearchParams('flag=1'), 'flag')).toBe(true);
  });

  it('returns true for "true"', () => {
    expect(parseQueryParamBoolean(new URLSearchParams('flag=true'), 'flag')).toBe(true);
  });

  it('returns false for "0"', () => {
    expect(parseQueryParamBoolean(new URLSearchParams('flag=0'), 'flag')).toBe(false);
  });

  it('returns false for "false"', () => {
    expect(parseQueryParamBoolean(new URLSearchParams('flag=false'), 'flag')).toBe(false);
  });

  it('returns undefined for missing key', () => {
    expect(parseQueryParamBoolean(new URLSearchParams(), 'flag')).toBeUndefined();
  });

  it('returns undefined for unrecognised value', () => {
    expect(parseQueryParamBoolean(new URLSearchParams('flag=yes'), 'flag')).toBeUndefined();
  });
});

describe('parseQueryParamInt', () => {
  it('parses a valid integer', () => {
    expect(parseQueryParamInt(new URLSearchParams('n=42'), 'n')).toBe(42);
  });

  it('parses negative integers', () => {
    expect(parseQueryParamInt(new URLSearchParams('n=-5'), 'n')).toBe(-5);
  });

  it('returns undefined for missing key', () => {
    expect(parseQueryParamInt(new URLSearchParams(), 'n')).toBeUndefined();
  });

  it('returns undefined for non-numeric value', () => {
    expect(parseQueryParamInt(new URLSearchParams('n=abc'), 'n')).toBeUndefined();
  });

  it('truncates floats to integer', () => {
    expect(parseQueryParamInt(new URLSearchParams('n=3.7'), 'n')).toBe(3);
  });
});

// ---------- readFiltersFromQuery ----------

describe('readFiltersFromQuery', () => {
  it('returns empty partial when no relevant params exist', () => {
    const result = readFiltersFromQuery(new URLSearchParams());
    expect(result).toEqual({});
  });

  it('yields the sends+attempts default when no sends/attempts params are present', () => {
    // A URL with no status params must resolve to the resting default (now sends +
    // attempts). readFiltersFromQuery omits unset status, so merging its partial over
    // DEFAULT_FILTERS is the real resolution the feed sees. Guard the default too so
    // this test tracks any future flip of the resting status.
    expect(DEFAULT_FILTERS.includeSends).toBe(true);
    expect(DEFAULT_FILTERS.includeAttempts).toBe(true);

    const partial = readFiltersFromQuery(new URLSearchParams('minGrade=10'));
    expect(partial.includeSends).toBeUndefined();
    expect(partial.includeAttempts).toBeUndefined();

    const resolved = { ...DEFAULT_FILTERS, ...partial };
    expect(resolved.includeSends).toBe(true);
    expect(resolved.includeAttempts).toBe(true);
  });

  it('parses boolean filter params', () => {
    const params = new URLSearchParams('sends=0&attempts=1&flash=1&benchmark=0');
    const result = readFiltersFromQuery(params);
    expect(result.includeSends).toBe(false);
    expect(result.includeAttempts).toBe(true);
    expect(result.flashOnly).toBe(true);
    expect(result.benchmarkOnly).toBe(false);
  });

  // Back-compat: a URL naming only one status side omits the other, which used to
  // default to "on". Fill the missing side with true so pre-migration bookmarks
  // keep their meaning (and the current "both" serialization `?attempts=1` reads
  // as both, not sends-only / empty).
  it('treats a lone sends=0 as attempts-only (old bookmark)', () => {
    const result = readFiltersFromQuery(new URLSearchParams('sends=0'));
    expect(result.includeSends).toBe(false);
    expect(result.includeAttempts).toBe(true);
  });

  it('treats a lone attempts=0 as sends-only', () => {
    const result = readFiltersFromQuery(new URLSearchParams('attempts=0'));
    expect(result.includeSends).toBe(true);
    expect(result.includeAttempts).toBe(false);
  });

  it('treats a lone attempts=1 as both (current "both" serialization)', () => {
    const result = readFiltersFromQuery(new URLSearchParams('attempts=1'));
    expect(result.includeSends).toBe(true);
    expect(result.includeAttempts).toBe(true);
  });

  it('parses grade params', () => {
    const params = new URLSearchParams('minGrade=10&maxGrade=20');
    const result = readFiltersFromQuery(params);
    expect(result.minGrade).toBe(10);
    expect(result.maxGrade).toBe(20);
  });

  it('parses date params', () => {
    const params = new URLSearchParams('from=2024-01-01&to=2024-12-31');
    const result = readFiltersFromQuery(params);
    expect(result.fromDate).toBe('2024-01-01');
    expect(result.toDate).toBe('2024-12-31');
  });

  it('ignores non-ISO date strings', () => {
    const params = new URLSearchParams('from=abc&to=2024/12/31');
    const result = readFiltersFromQuery(params);
    expect(result.fromDate).toBeUndefined();
    expect(result.toDate).toBeUndefined();
  });

  it('ignores empty date params', () => {
    const params = new URLSearchParams('from=&to=');
    const result = readFiltersFromQuery(params);
    expect(result.fromDate).toBeUndefined();
    expect(result.toDate).toBeUndefined();
  });

  it('ignores partial date formats', () => {
    const params = new URLSearchParams('from=2024-01&to=2024');
    const result = readFiltersFromQuery(params);
    expect(result.fromDate).toBeUndefined();
    expect(result.toDate).toBeUndefined();
  });

  it('rejects semantically invalid dates', () => {
    // 2024-13-40 matches the regex but is not a real date. The backend
    // forwards unchecked strings to PostgreSQL, so catching this on the
    // client avoids a cryptic DB error later.
    expect(readFiltersFromQuery(new URLSearchParams('from=2024-13-40')).fromDate).toBeUndefined();
    expect(readFiltersFromQuery(new URLSearchParams('to=2024-02-30')).toDate).toBeUndefined();
    expect(readFiltersFromQuery(new URLSearchParams('from=2023-02-29')).fromDate).toBeUndefined();
  });

  it('accepts valid leap-day dates', () => {
    expect(readFiltersFromQuery(new URLSearchParams('from=2024-02-29')).fromDate).toBe('2024-02-29');
  });

  it('parses angle range with both params', () => {
    const params = new URLSearchParams('minAngle=10&maxAngle=50');
    const result = readFiltersFromQuery(params);
    expect(result.angleRange).toEqual([10, 50]);
  });

  it('uses default for missing angle bound', () => {
    const params = new URLSearchParams('minAngle=15');
    const result = readFiltersFromQuery(params);
    expect(result.angleRange).toEqual([15, DEFAULT_ANGLE_RANGE[1]]);
  });

  it('does not set angleRange when neither param present', () => {
    const result = readFiltersFromQuery(new URLSearchParams());
    expect(result.angleRange).toBeUndefined();
  });

  it('ignores unrelated params', () => {
    const params = new URLSearchParams('page=2&foo=bar');
    const result = readFiltersFromQuery(params);
    expect(Object.keys(result)).toHaveLength(0);
  });
});

// ---------- readSortFromQuery ----------

describe('readSortFromQuery', () => {
  it('returns empty partial when no sort params', () => {
    expect(readSortFromQuery(new URLSearchParams())).toEqual({});
  });

  it('parses primary sort field and sets mode to custom', () => {
    const params = new URLSearchParams('sort=climbName');
    const result = readSortFromQuery(params);
    expect(result.mode).toBe('custom');
    expect(result.primaryField).toBe('climbName');
  });

  it('parses sort direction with implicit default field', () => {
    const params = new URLSearchParams('order=asc');
    const result = readSortFromQuery(params);
    expect(result.mode).toBe('custom');
    expect(result.primaryField).toBe('date');
    expect(result.primaryDirection).toBe('asc');
  });

  it('parses secondary sort', () => {
    const params = new URLSearchParams('sort2=date&order2=asc');
    const result = readSortFromQuery(params);
    expect(result.secondaryField).toBe('date');
    expect(result.secondaryDirection).toBe('asc');
  });

  it('ignores invalid sort fields', () => {
    const params = new URLSearchParams('sort=invalid');
    const result = readSortFromQuery(params);
    expect(result.mode).toBeUndefined();
    expect(result.primaryField).toBeUndefined();
  });

  it('ignores invalid sort direction', () => {
    const params = new URLSearchParams('order=sideways');
    const result = readSortFromQuery(params);
    expect(result.primaryDirection).toBeUndefined();
  });

  it('applies direction with default field when sort is empty and order is present', () => {
    const params = new URLSearchParams('sort=&order=asc');
    const result = readSortFromQuery(params);
    expect(result.mode).toBe('custom');
    expect(result.primaryField).toBe(DEFAULT_SORT.primaryField);
    expect(result.primaryDirection).toBe('asc');
  });

  it('does not apply direction when sort is invalid and order is present', () => {
    const params = new URLSearchParams('sort=invalid&order=asc');
    const result = readSortFromQuery(params);
    expect(result.mode).toBeUndefined();
    expect(result.primaryField).toBeUndefined();
    expect(result.primaryDirection).toBeUndefined();
  });
});

// ---------- filtersToQueryParams ----------

describe('filtersToQueryParams', () => {
  it('returns empty object for all defaults', () => {
    const result = filtersToQueryParams('', DEFAULT_FILTERS, DEFAULT_SORT, []);
    expect(result).toEqual({});
  });

  it('includes search text', () => {
    const result = filtersToQueryParams('test climb', DEFAULT_FILTERS, DEFAULT_SORT, []);
    expect(result.q).toBe('test climb');
  });

  it('includes selected board UUIDs', () => {
    const result = filtersToQueryParams('', DEFAULT_FILTERS, DEFAULT_SORT, ['uuid-1', 'uuid-2']);
    expect(result.boards).toBe('uuid-1,uuid-2');
  });

  it('includes grade range when set', () => {
    const filters = {
      ...DEFAULT_FILTERS,
      minGrade: 10 as number | '',
      maxGrade: 20 as number | '',
    };
    const result = filtersToQueryParams('', filters, DEFAULT_SORT, []);
    expect(result.minGrade).toBe('10');
    expect(result.maxGrade).toBe('20');
  });

  it('serialises non-default boolean filters', () => {
    const filters = { ...DEFAULT_FILTERS, includeSends: false, flashOnly: true };
    const result = filtersToQueryParams('', filters, DEFAULT_SORT, []);
    expect(result.sends).toBe('0');
    expect(result.flash).toBe('1');
    // includeAttempts stays default → omitted
    expect(result.attempts).toBeUndefined();
  });

  it('serialises disabled attempts (off the sends+attempts default)', () => {
    // The status resting state now includes attempts, so turning attempts OFF is
    // the non-default change and is serialised as the real value.
    const filters = { ...DEFAULT_FILTERS, includeAttempts: false };
    const result = filtersToQueryParams('', filters, DEFAULT_SORT, []);
    expect(result.attempts).toBe('0');
  });

  it('serialises attempts-only (sends off, attempts on)', () => {
    // Sends off is the non-default change; attempts on is now the default, so only
    // the sends param is emitted.
    const filters = { ...DEFAULT_FILTERS, includeSends: false, includeAttempts: true };
    const result = filtersToQueryParams('', filters, DEFAULT_SORT, []);
    expect(result.sends).toBe('0');
    expect(result.attempts).toBeUndefined();
  });

  it('includes date range', () => {
    const filters = { ...DEFAULT_FILTERS, fromDate: '2024-01-01', toDate: '2024-06-30' };
    const result = filtersToQueryParams('', filters, DEFAULT_SORT, []);
    expect(result.from).toBe('2024-01-01');
    expect(result.to).toBe('2024-06-30');
  });

  it('includes angle range when non-default', () => {
    const filters = { ...DEFAULT_FILTERS, angleRange: [10, 50] as [number, number] };
    const result = filtersToQueryParams('', filters, DEFAULT_SORT, []);
    expect(result.minAngle).toBe('10');
    expect(result.maxAngle).toBe('50');
  });

  it('omits default angle values', () => {
    const result = filtersToQueryParams('', DEFAULT_FILTERS, DEFAULT_SORT, []);
    expect(result.minAngle).toBeUndefined();
    expect(result.maxAngle).toBeUndefined();
  });

  it('includes custom sort params', () => {
    const sort = {
      ...DEFAULT_SORT,
      mode: 'custom' as const,
      primaryField: 'climbName' as const,
      primaryDirection: 'asc' as const,
    };
    const result = filtersToQueryParams('', DEFAULT_FILTERS, sort, []);
    expect(result.sort).toBe('climbName');
    expect(result.order).toBe('asc');
  });

  it('always emits sort field in custom mode even when default', () => {
    const sort = {
      ...DEFAULT_SORT,
      mode: 'custom' as const,
      primaryField: 'date' as const,
      primaryDirection: 'asc' as const,
    };
    const result = filtersToQueryParams('', DEFAULT_FILTERS, sort, []);
    expect(result.sort).toBe('date');
    expect(result.order).toBe('asc');
  });

  it('omits sort when using preset mode', () => {
    const result = filtersToQueryParams('', DEFAULT_FILTERS, DEFAULT_SORT, []);
    expect(result.sort).toBeUndefined();
    expect(result.order).toBeUndefined();
  });

  it('includes secondary sort when set', () => {
    const sort = {
      ...DEFAULT_SORT,
      mode: 'custom' as const,
      secondaryField: 'loggedGrade' as const,
      secondaryDirection: 'asc' as const,
    };
    const result = filtersToQueryParams('', DEFAULT_FILTERS, sort, []);
    expect(result.sort2).toBe('loggedGrade');
    expect(result.order2).toBe('asc');
  });

  it('omits secondary order when desc (default)', () => {
    const sort = {
      ...DEFAULT_SORT,
      mode: 'custom' as const,
      secondaryField: 'loggedGrade' as const,
      secondaryDirection: 'desc' as const,
    };
    const result = filtersToQueryParams('', DEFAULT_FILTERS, sort, []);
    expect(result.sort2).toBe('loggedGrade');
    expect(result.order2).toBeUndefined();
  });

  it('round-trips through readFiltersFromQuery', () => {
    // Both status booleans off the sends-only default (attempts-only) so each is
    // serialised and round-trips; flashOnly rides along (it's a send refinement,
    // and the URL layer preserves what it's given — sanitize heals edge cases).
    const filters = {
      ...DEFAULT_FILTERS,
      includeSends: false,
      includeAttempts: true,
      flashOnly: true,
      benchmarkOnly: true,
      minGrade: 12 as number | '',
      maxGrade: 18 as number | '',
      fromDate: '2024-03-01',
      toDate: '2024-09-15',
      angleRange: [5, 60] as [number, number],
    };
    const params = filtersToQueryParams('search term', filters, DEFAULT_SORT, ['b1', 'b2']);
    const parsed = readFiltersFromQuery(new URLSearchParams(params));

    expect(parsed.includeSends).toBe(false);
    expect(parsed.includeAttempts).toBe(true);
    expect(parsed.flashOnly).toBe(true);
    expect(parsed.benchmarkOnly).toBe(true);
    expect(parsed.minGrade).toBe(12);
    expect(parsed.maxGrade).toBe(18);
    expect(parsed.fromDate).toBe('2024-03-01');
    expect(parsed.toDate).toBe('2024-09-15');
    expect(parsed.angleRange).toEqual([5, 60]);
  });

  it('round-trips sort through readSortFromQuery', () => {
    const sort = {
      ...DEFAULT_SORT,
      mode: 'custom' as const,
      primaryField: 'attemptCount' as const,
      primaryDirection: 'asc' as const,
      secondaryField: 'date' as const,
      secondaryDirection: 'asc' as const,
    };
    const params = filtersToQueryParams('', DEFAULT_FILTERS, sort, []);
    const parsed = readSortFromQuery(new URLSearchParams(params));

    expect(parsed.mode).toBe('custom');
    expect(parsed.primaryField).toBe('attemptCount');
    expect(parsed.primaryDirection).toBe('asc');
    expect(parsed.secondaryField).toBe('date');
    expect(parsed.secondaryDirection).toBe('asc');
  });
});
