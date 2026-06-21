import { describe, it, expect, vi } from 'vitest';
import type { Grade } from '@boardsesh/shared-schema';
import type { ClimbBoardFilterState } from '@boardsesh/climb-filters';
import { getActiveFilterTokens, type FilterToken } from '../filter-tokens';
import { DEFAULT_FILTERS, type ClimbFilters } from '../climb-filter-types';

const mockGrades: Grade[] = [
  { difficultyId: 5, name: 'V2' },
  { difficultyId: 10, name: 'V4' },
  { difficultyId: 15, name: 'V6' },
];

// Single-scale formatter (the user's preferred V scale), mirroring useGradeFormat.
const V_BY_ID: Record<number, string> = { 5: 'V2', 10: 'V4', 15: 'V6' };
const mockFormatGradeById = (id: number | null | undefined) => (id == null ? null : (V_BY_ID[id] ?? null));
const text = (value: unknown) => (typeof value === 'string' || typeof value === 'number' ? String(value) : '');

const mockT = ((key: string, options?: Record<string, unknown>) => {
  if (key === 'mobile.search.gradeRange') return `${text(options?.min)}–${text(options?.max)}`;
  if (key === 'mobile.search.gradeMin') return `${text(options?.grade)}+`;
  if (key === 'mobile.search.gradeMax') return `≤${text(options?.grade)}`;
  if (key === 'mobile.search.ascents') return `${text(options?.count)}+ 🧗`;
  if (key === 'mobile.search.rating') return `${text(options?.count)}+ ⭐`;
  if (key === 'mobile.search.setterName') return `By ${text(options?.setter)}`;
  if (key === 'mobile.search.settersCount') return `${text(options?.count)} setters`;
  if (key === 'search.summary.routesOnly') return 'Routes only';
  if (key === 'search.summary.bouldersAndRoutes') return 'Boulders & routes';
  if (key === 'mobile.filter.sort.quality') return 'Quality';
  if (key === 'mobile.filter.benchmark') return 'Benchmarks only';
  if (key === 'mobile.filter.status.drafts') return 'Drafts';
  if (key === 'mobile.filter.tallClimbs') return 'Tall climbs';
  if (key === 'mobile.holdFilter.summaryCount') return `${text(options?.count)} holds`;
  if (key === 'mobile.zoneFilter.title') return 'Board region';
  return key;
}) as unknown as Parameters<typeof getActiveFilterTokens>[0]['t'];

function build(
  filters: ClimbFilters,
  boardFilters: ClimbBoardFilterState = {},
  grades: Grade[] | undefined = mockGrades,
) {
  const patchFilters = vi.fn();
  const patchBoardFilters = vi.fn();
  const setGrade = vi.fn();
  const tokens = getActiveFilterTokens({
    filters,
    boardFilters,
    grades,
    t: mockT,
    formatGradeByDifficultyId: mockFormatGradeById,
    patchFilters,
    patchBoardFilters,
    setGrade,
  });
  return { tokens, patchFilters, patchBoardFilters, setGrade };
}

const keys = (tokens: FilterToken[]) => tokens.map((token) => token.key);

describe('getActiveFilterTokens', () => {
  it('returns no tokens for the default state', () => {
    expect(build(DEFAULT_FILTERS).tokens).toEqual([]);
  });

  it('builds a single grade token for a bound and clears it via setGrade', () => {
    const { tokens, setGrade } = build({ ...DEFAULT_FILTERS, minGrade: 5, maxGrade: 15 });
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ key: 'grade', label: 'V2–V6' });
    tokens[0].clear();
    expect(setGrade).toHaveBeenCalledWith({ minGradeId: undefined, maxGradeId: undefined });
  });

  it('omits the grade token when grades data is unavailable', () => {
    // Call directly: a default param can't be overridden by an explicit
    // `undefined`, so the helper's `grades = mockGrades` default would win.
    const tokens = getActiveFilterTokens({
      filters: { ...DEFAULT_FILTERS, minGrade: 10 },
      boardFilters: {},
      grades: undefined,
      t: mockT,
      formatGradeByDifficultyId: mockFormatGradeById,
      patchFilters: vi.fn(),
      patchBoardFilters: vi.fn(),
      setGrade: vi.fn(),
    });
    expect(keys(tokens)).not.toContain('grade');
  });

  it('resets sort to the default on clear', () => {
    const { tokens, patchFilters } = build({ ...DEFAULT_FILTERS, sortBy: 'quality' });
    const sort = tokens.find((token) => token.key === 'sort');
    expect(sort?.label).toBe('Quality');
    sort?.clear();
    expect(patchFilters).toHaveBeenCalledWith({ sortBy: DEFAULT_FILTERS.sortBy, sortOrder: DEFAULT_FILTERS.sortOrder });
  });

  it('builds a single-setter token from the translated setter name and clears the setter list', () => {
    const { tokens, patchFilters } = build({ ...DEFAULT_FILTERS, setter: ['marco'] });
    const setter = tokens.find((token) => token.key === 'setter');
    expect(setter?.label).toBe('By marco');
    setter?.clear();
    expect(patchFilters).toHaveBeenCalledWith({ setter: undefined });
  });

  it('builds a multi-setter token labelled by count and clears the setter list', () => {
    const { tokens, patchFilters } = build({ ...DEFAULT_FILTERS, setter: ['a', 'b'] });
    const setter = tokens.find((token) => token.key === 'setter');
    expect(setter?.label).toBe('2 setters');
    setter?.clear();
    expect(patchFilters).toHaveBeenCalledWith({ setter: undefined });
  });

  it('builds a Routes-only climb-type token and clears to boulders-only default', () => {
    const { tokens, patchFilters } = build({ ...DEFAULT_FILTERS, boulders: false, routes: true });
    const climbType = tokens.find((token) => token.key === 'climbType');
    expect(climbType?.label).toBe('Routes only');
    climbType?.clear();
    expect(patchFilters).toHaveBeenCalledWith({ boulders: true, routes: false });
  });

  it('builds a benchmark token from board filters and clears via patchBoardFilters', () => {
    const { tokens, patchBoardFilters } = build(DEFAULT_FILTERS, { onlyBenchmarks: true });
    const benchmark = tokens.find((token) => token.key === 'benchmark');
    expect(benchmark?.label).toBe('Benchmarks only');
    benchmark?.clear();
    expect(patchBoardFilters).toHaveBeenCalledWith({ onlyBenchmarks: false });
  });

  it('builds a holds token labelled by hold count and clears the holds filter', () => {
    const { tokens, patchBoardFilters } = build(DEFAULT_FILTERS, {
      holdsFilter: { '5': { HAND: 'include' }, '6': { FINISH: 'exclude' } },
    });
    const holds = tokens.find((token) => token.key === 'holds');
    expect(holds?.label).toBe('2 holds');
    holds?.clear();
    expect(patchBoardFilters).toHaveBeenCalledWith({ holdsFilter: undefined });
  });

  it('omits the holds token when the holds filter has no entries', () => {
    expect(keys(build(DEFAULT_FILTERS, { holdsFilter: {} }).tokens)).not.toContain('holds');
  });

  it('builds a zone token and clears the zone box and mode', () => {
    const { tokens, patchBoardFilters } = build(DEFAULT_FILTERS, {
      zoneBox: { edgeLeft: 0, edgeRight: 10, edgeBottom: 0, edgeTop: 10 },
      zoneMode: 'allHolds',
    });
    const zone = tokens.find((token) => token.key === 'zone');
    expect(zone?.label).toBe('Board region');
    zone?.clear();
    expect(patchBoardFilters).toHaveBeenCalledWith({ zoneBox: null, zoneMode: undefined });
  });

  it('orders grade first, then refinements in summary order', () => {
    const { tokens } = build({
      ...DEFAULT_FILTERS,
      minGrade: 5,
      maxGrade: 15,
      minAscents: 10,
      status: 'drafts',
      routes: true,
    });
    expect(keys(tokens)).toEqual(['grade', 'minAscents', 'status', 'climbType']);
  });
});
