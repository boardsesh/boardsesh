import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import type { Grade } from '@boardsesh/shared-schema';
import { DEFAULT_LOGBOOK_FILTERS, type LogbookFilterState } from '@boardsesh/logbook';
import {
  anyFilterActive,
  angleChipLabel,
  buildLogbookFacets,
  dateChipLabel,
  gradeChipLabel,
  type LogbookFacet,
  type LogbookFacetKey,
} from '../LogbookChipRow.logic';

// A grade scale (difficultyId → raw name) plus a formatter that renders the raw
// name as its V-grade — mirroring how GradeRangeRail resolves a chip label.
const GRADES: Grade[] = [
  { difficultyId: 10, name: '6a' },
  { difficultyId: 12, name: '6a+' },
  { difficultyId: 14, name: '6b' },
];
const V_BY_NAME: Record<string, string> = { '6a': 'V3', '6a+': 'V4', '6b': 'V5' };
const formatGrade = (name: string): string | null => V_BY_NAME[name] ?? null;

// Stub t: return the key for plain keys, interpolate {{date}} for the date keys.
const t = ((key: string, opts?: { date?: string }) => {
  if (opts?.date) return `${key}:${opts.date}`;
  return key;
}) as unknown as TFunction<'you'>;

function withFilters(patch: Partial<LogbookFilterState>): LogbookFilterState {
  return { ...DEFAULT_LOGBOOK_FILTERS, ...patch };
}

function facetByKey(facets: LogbookFacet[], key: LogbookFacetKey): LogbookFacet {
  const found = facets.find((facet) => facet.key === key);
  if (!found) throw new Error(`missing facet ${key}`);
  return found;
}

describe('buildLogbookFacets', () => {
  it('always returns all four facets in [grade, angle, show, date] order', () => {
    const facets = buildLogbookFacets(DEFAULT_LOGBOOK_FILTERS, GRADES, formatGrade, t);
    expect(facets.map((facet) => facet.key)).toEqual(['grade', 'angle', 'show', 'date']);
  });

  it('marks every facet inactive with its placeholder for the default filters', () => {
    const facets = buildLogbookFacets(DEFAULT_LOGBOOK_FILTERS, GRADES, formatGrade, t);
    expect(facets.every((facet) => !facet.active)).toBe(true);
    expect(facetByKey(facets, 'grade').label).toBe('mobile.logbook.grade');
    expect(facetByKey(facets, 'angle').label).toBe('mobile.logbook.angle');
    expect(facetByKey(facets, 'show').label).toBe('mobile.logbook.show');
    expect(facetByKey(facets, 'date').label).toBe('mobile.logbook.dateRange');
  });

  it('activates the grade facet with the V-range label when a bound is set', () => {
    const facets = buildLogbookFacets(withFilters({ minGrade: 10, maxGrade: 14 }), GRADES, formatGrade, t);
    const grade = facetByKey(facets, 'grade');
    expect(grade.active).toBe(true);
    expect(grade.label).toBe('V3–V5');
  });

  it('shows the grade placeholder (not the raw id) while the grade facet is set but grades have not loaded', () => {
    // The scale is still loading (empty grade list), so the chip stays amber but
    // reads "Grade" instead of the raw "≥12" id — the formatted value appears once
    // the scale arrives.
    const facets = buildLogbookFacets(withFilters({ minGrade: 12 }), [], formatGrade, t);
    const grade = facetByKey(facets, 'grade');
    expect(grade.active).toBe(true);
    expect(grade.label).toBe('mobile.logbook.grade');
  });

  it('activates the angle facet with the degree-range label when narrowed', () => {
    const facets = buildLogbookFacets(withFilters({ angleRange: [20, 40] }), GRADES, formatGrade, t);
    const angle = facetByKey(facets, 'angle');
    expect(angle.active).toBe(true);
    expect(angle.label).toBe('20°–40°');
  });

  it('keeps the show facet inactive for the sends+attempts default', () => {
    // The default now rests on sends + attempts, so the Show facet is not amber.
    const show = facetByKey(buildLogbookFacets(DEFAULT_LOGBOOK_FILTERS, GRADES, formatGrade, t), 'show');
    expect(show.active).toBe(false);
  });

  it('activates the show facet for a narrowed status — sends-only or attempts-only (label stays "Show")', () => {
    // sends-only is off the sends+attempts default.
    const sendsOnly = facetByKey(
      buildLogbookFacets(withFilters({ includeAttempts: false }), GRADES, formatGrade, t),
      'show',
    );
    expect(sendsOnly.active).toBe(true);
    expect(sendsOnly.label).toBe('mobile.logbook.show');
    // attempts-only.
    const attempts = facetByKey(
      buildLogbookFacets(withFilters({ includeSends: false, includeAttempts: true }), GRADES, formatGrade, t),
      'show',
    );
    expect(attempts.active).toBe(true);
  });

  it('activates the show facet for flashOnly and for benchmarkOnly', () => {
    expect(
      facetByKey(buildLogbookFacets(withFilters({ flashOnly: true }), GRADES, formatGrade, t), 'show').active,
    ).toBe(true);
    expect(
      facetByKey(buildLogbookFacets(withFilters({ benchmarkOnly: true }), GRADES, formatGrade, t), 'show').active,
    ).toBe(true);
  });

  it('activates the date facet with the localized short range when a bound is set', () => {
    const facets = buildLogbookFacets(
      withFilters({ fromDate: '2026-06-01', toDate: '2026-06-30' }),
      GRADES,
      formatGrade,
      t,
    );
    const date = facetByKey(facets, 'date');
    expect(date.active).toBe(true);
    expect(date.label).toContain('–');
  });

  it('falls back to the date placeholder when the bound does not parse', () => {
    const facets = buildLogbookFacets(withFilters({ fromDate: 'not-a-date' }), GRADES, formatGrade, t);
    const date = facetByKey(facets, 'date');
    // The field is "set" (active), but the unparseable bound shows the placeholder.
    expect(date.active).toBe(true);
    expect(date.label).toBe('mobile.logbook.dateRange');
  });
});

describe('anyFilterActive', () => {
  it('is false when no facet is active', () => {
    expect(anyFilterActive(buildLogbookFacets(DEFAULT_LOGBOOK_FILTERS, GRADES, formatGrade, t))).toBe(false);
  });

  it('is true when at least one facet is active', () => {
    expect(anyFilterActive(buildLogbookFacets(withFilters({ benchmarkOnly: true }), GRADES, formatGrade, t))).toBe(
      true,
    );
  });
});

describe('gradeChipLabel', () => {
  const gradesById = new Map(GRADES.map((grade) => [grade.difficultyId, grade.name]));

  it('formats a two-ended range with an en dash', () => {
    expect(gradeChipLabel(10, 14, gradesById, formatGrade)).toBe('V3–V5');
  });

  it('collapses equal bounds to a single grade', () => {
    expect(gradeChipLabel(12, 12, gradesById, formatGrade)).toBe('V4');
  });

  it('prefixes a min-only bound with ≥', () => {
    expect(gradeChipLabel(12, '', gradesById, formatGrade)).toBe('≥V4');
  });

  it('prefixes a max-only bound with ≤', () => {
    expect(gradeChipLabel('', 14, gradesById, formatGrade)).toBe('≤V5');
  });

  it('falls back to the id when the grade is off-scale', () => {
    expect(gradeChipLabel(99, '', gradesById, formatGrade)).toBe('≥99');
  });
});

describe('dateChipLabel', () => {
  it('joins both bounds with an en dash', () => {
    const label = dateChipLabel('2026-06-01', '2026-06-30', t);
    expect(label).toContain('–');
  });

  it('uses the Since prefix for a from-only bound', () => {
    const label = dateChipLabel('2026-06-01', '', t);
    expect(label?.startsWith('mobile.logbook.dateSince:')).toBe(true);
  });

  it('uses the Until prefix for a to-only bound', () => {
    const label = dateChipLabel('', '2026-06-30', t);
    expect(label?.startsWith('mobile.logbook.dateUntil:')).toBe(true);
  });

  it('returns null when neither bound parses', () => {
    expect(dateChipLabel('not-a-date', '', t)).toBeNull();
  });

  it('parses a bare ISO date as local midnight (no UTC day-shift)', () => {
    // `new Date("2024-01-15")` is UTC midnight — a day earlier in negative-offset
    // zones, which would disagree with the date picker's local-midnight parse. The
    // label must read the ISO's own calendar day in any timezone.
    const expected = new Date(2024, 0, 15).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    expect(dateChipLabel('2024-01-15', '', t)).toBe(`mobile.logbook.dateSince:${expected}`);
  });
});

describe('angleChipLabel', () => {
  it('formats a degree range', () => {
    expect(angleChipLabel([5, 45])).toBe('5°–45°');
  });
});
