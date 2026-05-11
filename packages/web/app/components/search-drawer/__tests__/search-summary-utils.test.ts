import { describe, it, expect } from 'vite-plus/test';
import {
  hasActiveNonNameFilters,
  hasActiveFilters,
  getStatusPanelSummary,
  getQualityPanelSummary,
  getSearchPillSummary,
  getUserPanelSummary,
} from '../search-summary-utils';
import { DEFAULT_SEARCH_PARAMS } from '@/app/lib/url-utils';
import type { SearchRequestPagination } from '@/app/lib/types';

function makeParams(overrides: Partial<SearchRequestPagination> = {}): SearchRequestPagination {
  return { ...DEFAULT_SEARCH_PARAMS, ...overrides } as SearchRequestPagination;
}

describe('hasActiveNonNameFilters', () => {
  it('returns false when all params match defaults', () => {
    expect(hasActiveNonNameFilters(makeParams())).toBe(false);
  });

  it('returns false when only the name filter is active', () => {
    expect(hasActiveNonNameFilters(makeParams({ name: 'Cool Boulder' }))).toBe(false);
  });

  it('returns true when minGrade is set', () => {
    expect(hasActiveNonNameFilters(makeParams({ minGrade: 16 }))).toBe(true);
  });

  it('returns true when maxGrade is set', () => {
    expect(hasActiveNonNameFilters(makeParams({ maxGrade: 24 }))).toBe(true);
  });

  it('returns true when grade filters are active even with a name filter', () => {
    expect(hasActiveNonNameFilters(makeParams({ name: 'Test', minGrade: 10, maxGrade: 20 }))).toBe(true);
  });

  it('returns true when holdsFilter has entries', () => {
    expect(
      hasActiveNonNameFilters(
        makeParams({
          holdsFilter: { 1: { HAND: 'include' as const } },
        }),
      ),
    ).toBe(true);
  });

  it('returns false when holdsFilter is empty object', () => {
    expect(hasActiveNonNameFilters(makeParams({ holdsFilter: {} }))).toBe(false);
  });

  it('returns true when onlyClassics is true', () => {
    expect(hasActiveNonNameFilters(makeParams({ onlyClassics: true }))).toBe(true);
  });

  it('returns true when minAscents differs from default', () => {
    expect(hasActiveNonNameFilters(makeParams({ minAscents: 5 }))).toBe(true);
  });

  it('returns true when minRating differs from default', () => {
    expect(hasActiveNonNameFilters(makeParams({ minRating: 3 }))).toBe(true);
  });

  it('returns true when hideAttempted is true', () => {
    expect(hasActiveNonNameFilters(makeParams({ hideAttempted: true }))).toBe(true);
  });

  it('returns true when minUserQuality is set', () => {
    expect(hasActiveNonNameFilters(makeParams({ minUserQuality: 4 }))).toBe(true);
  });

  it('returns true when hideWithoutUserQuality is true', () => {
    expect(hasActiveNonNameFilters(makeParams({ hideWithoutUserQuality: true }))).toBe(true);
  });

  it('returns true when sortBy differs from default', () => {
    expect(hasActiveNonNameFilters(makeParams({ sortBy: 'quality' }))).toBe(true);
  });
});

describe('hasActiveFilters', () => {
  it('returns false when all params match defaults', () => {
    expect(hasActiveFilters(makeParams())).toBe(false);
  });

  it('returns true when name is set (unlike hasActiveNonNameFilters)', () => {
    expect(hasActiveFilters(makeParams({ name: 'Cool Boulder' }))).toBe(true);
  });

  it('returns true when grade filters are active', () => {
    expect(hasActiveFilters(makeParams({ minGrade: 10 }))).toBe(true);
  });

  it('returns true when holdsFilter has entries', () => {
    expect(
      hasActiveFilters(
        makeParams({
          holdsFilter: { 1: { HAND: 'include' as const } },
        }),
      ),
    ).toBe(true);
  });
});

describe('getStatusPanelSummary', () => {
  it('returns empty for defaults', () => {
    expect(getStatusPanelSummary(makeParams())).toEqual([]);
  });

  it('returns ["Drafts"] when onlyDrafts is true (takes precedence over minAscents)', () => {
    expect(getStatusPanelSummary(makeParams({ onlyDrafts: true, minAscents: 5 }))).toEqual(['Drafts']);
  });

  it('returns ["Projects"] when projectsOnly is true', () => {
    expect(getStatusPanelSummary(makeParams({ projectsOnly: true }))).toEqual(['Projects']);
  });

  it('returns ["Established"] when minAscents is exactly 2', () => {
    expect(getStatusPanelSummary(makeParams({ minAscents: 2 }))).toEqual(['Established']);
  });

  it('returns ["Established"] when minAscents is >= 2 (e.g. 3, 10)', () => {
    expect(getStatusPanelSummary(makeParams({ minAscents: 3 }))).toEqual(['Established']);
    expect(getStatusPanelSummary(makeParams({ minAscents: 10 }))).toEqual(['Established']);
  });

  it('returns empty when minAscents is 1 (below the established threshold)', () => {
    expect(getStatusPanelSummary(makeParams({ minAscents: 1 }))).toEqual([]);
  });
});

describe('getQualityPanelSummary vs Status (no duplication)', () => {
  it('includes "1+ ascents" when minAscents is 1 (below Established)', () => {
    expect(getQualityPanelSummary(makeParams({ minAscents: 1 }))).toContain('1+ ascents');
  });

  it('rounds legacy decimal minRating summaries up to whole stars', () => {
    expect(getQualityPanelSummary(makeParams({ minRating: 2.5 }))).toContain('3+ rating');
  });

  it('does not include "N+ ascents" when minAscents is 2 (Established handles it)', () => {
    const parts = getQualityPanelSummary(makeParams({ minAscents: 2 }));
    expect(parts.find((p) => p.includes('ascents'))).toBeUndefined();
  });

  it('does not include "N+ ascents" when minAscents is 3 (Established handles it)', () => {
    const parts = getQualityPanelSummary(makeParams({ minAscents: 3 }));
    expect(parts.find((p) => p.includes('ascents'))).toBeUndefined();
  });

  it('pill summary for minAscents=3 shows "Established" only, no duplicate', () => {
    const pill = getSearchPillSummary(makeParams({ minAscents: 3 }), { zone: 'Zone', user: { myRating: (n: number) => `${n}+ my rating`, ratedOnly: 'Rated only' } });
    expect(pill).toContain('Established');
    expect(pill).not.toContain('3+ ascents');
  });

  it('pill summary for projects shows "Projects"', () => {
    const pill = getSearchPillSummary(makeParams({ projectsOnly: true }), { zone: 'Zone', user: { myRating: (n: number) => `${n}+ my rating`, ratedOnly: 'Rated only' } });
    expect(pill).toContain('Projects');
  });

  it('pill summary for drafts shows "Drafts"', () => {
    const pill = getSearchPillSummary(makeParams({ onlyDrafts: true }), { zone: 'Zone', user: { myRating: (n: number) => `${n}+ my rating`, ratedOnly: 'Rated only' } });
    expect(pill).toContain('Drafts');
  });
});

describe('getUserPanelSummary user-quality filter', () => {
  const userLabels = {
    myRating: (count: number) => `${count}+ my rating`,
    ratedOnly: 'Rated only',
  };

  it('returns empty when neither minUserQuality nor hideWithoutUserQuality is set', () => {
    expect(getUserPanelSummary(makeParams(), userLabels)).toEqual([]);
  });

  it('includes minUserQuality summary when threshold is set', () => {
    const parts = getUserPanelSummary(makeParams({ minUserQuality: 3 }), userLabels);
    expect(parts).toContain('3+ my rating');
  });

  it('includes "Rated only" when hideWithoutUserQuality is true', () => {
    const parts = getUserPanelSummary(makeParams({ hideWithoutUserQuality: true }), userLabels);
    expect(parts).toContain('Rated only');
  });

  it('combines both filters when set together', () => {
    const parts = getUserPanelSummary(
      makeParams({ minUserQuality: 4, hideWithoutUserQuality: true }),
      userLabels,
    );
    expect(parts).toContain('4+ my rating');
    expect(parts).toContain('Rated only');
  });

  it('coexists with hide/only progress filters', () => {
    const parts = getUserPanelSummary(
      makeParams({ minUserQuality: 5, hideAttempted: true, showOnlyCompleted: true }),
      userLabels,
    );
    expect(parts).toContain('5+ my rating');
    expect(parts).toContain('Hide attempted');
    expect(parts).toContain('Only completed');
  });

  it('normalises decimal minUserQuality to a whole star', () => {
    const parts = getUserPanelSummary(makeParams({ minUserQuality: 2.5 }), userLabels);
    expect(parts).toContain('3+ my rating');
  });
});
