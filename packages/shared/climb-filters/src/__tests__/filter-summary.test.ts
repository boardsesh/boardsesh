import { describe, it, expect } from 'vitest';
import type { Grade } from '@boardsesh/shared-schema';
import { getBaseFilterParts, formatFilterSummary, type FilterSummaryLabels, type BaseFilters } from '../filter-summary';

const mockGrades: Grade[] = [
  { difficultyId: 1, name: 'V0' },
  { difficultyId: 5, name: 'V2' },
  { difficultyId: 10, name: 'V4' },
  { difficultyId: 15, name: 'V6' },
  { difficultyId: 20, name: 'V8' },
];

const labels: FilterSummaryLabels = {
  gradeRange: (min, max) => `${min}–${max}`,
  gradeMin: (grade) => `${grade}+`,
  gradeMax: (grade) => `Up to ${grade}`,
  ascents: (count) => `${count}+ ascents`,
  rating: (count) => `${count}+ stars`,
  more: (count) => `+${count} more`,
};

const sortLabel = (sortBy: string) => {
  const map: Record<string, string> = { quality: 'Quality', difficulty: 'Difficulty', newest: 'Newest' };
  return map[sortBy];
};

describe('getBaseFilterParts', () => {
  it('returns empty array when no filters are active', () => {
    expect(getBaseFilterParts({}, mockGrades, labels)).toEqual([]);
  });

  it('includes search text in quotes', () => {
    expect(getBaseFilterParts({ name: 'crimp' }, mockGrades, labels)).toEqual(['"crimp"']);
  });

  it('shows grade range when both min and max set', () => {
    const filters: BaseFilters = { minGrade: 5, maxGrade: 15 };
    expect(getBaseFilterParts(filters, mockGrades, labels)).toEqual(['V2–V6']);
  });

  it('shows a single grade name when min and max are the same grade', () => {
    const filters: BaseFilters = { minGrade: 15, maxGrade: 15 };
    expect(getBaseFilterParts(filters, mockGrades, labels)).toEqual(['V6']);
  });

  it('shows min grade with plus', () => {
    expect(getBaseFilterParts({ minGrade: 10 }, mockGrades, labels)).toEqual(['V4+']);
  });

  it('shows max grade with up-to prefix', () => {
    expect(getBaseFilterParts({ maxGrade: 15 }, mockGrades, labels)).toEqual(['Up to V6']);
  });

  it('shows sort label when non-default', () => {
    const filters: BaseFilters = { sortBy: 'quality', defaultSortBy: 'popular' };
    expect(getBaseFilterParts(filters, mockGrades, labels, sortLabel)).toEqual(['Quality']);
  });

  it('skips sort label when sortBy matches default', () => {
    const filters: BaseFilters = { sortBy: 'popular', defaultSortBy: 'popular' };
    expect(getBaseFilterParts(filters, mockGrades, labels, sortLabel)).toEqual([]);
  });

  it('shows ascents count', () => {
    expect(getBaseFilterParts({ minAscents: 25 }, mockGrades, labels)).toEqual(['25+ ascents']);
  });

  it('shows rating count', () => {
    expect(getBaseFilterParts({ minRating: 3 }, mockGrades, labels)).toEqual(['3+ stars']);
  });

  it('falls back to difficultyId when grade not found', () => {
    expect(getBaseFilterParts({ minGrade: 999 }, mockGrades, labels)).toEqual(['#999+']);
  });

  it('combines multiple parts', () => {
    const filters: BaseFilters = { name: 'test', minGrade: 10, minAscents: 5 };
    expect(getBaseFilterParts(filters, mockGrades, labels)).toEqual(['"test"', 'V4+', '5+ ascents']);
  });

  it('includes minAscents >= 2 (web suppresses this for the Established chip separately)', () => {
    expect(getBaseFilterParts({ minAscents: 2 }, mockGrades, labels)).toEqual(['2+ ascents']);
    expect(getBaseFilterParts({ minAscents: 10 }, mockGrades, labels)).toEqual(['10+ ascents']);
  });
});

describe('getBaseFilterParts — extended fields', () => {
  const extendedLabels: FilterSummaryLabels = {
    ...labels,
    setters: (count) => `${count} setter${count === 1 ? '' : 's'}`,
    gradeAccuracy: (value) => `±${value}`,
    tallOnly: () => 'Tall only',
    wideOnly: () => 'Wide only',
    status: (kind) => `Status: ${kind}`,
    hideAttempted: () => 'Hide attempted',
    hideCompleted: () => 'Hide completed',
    showOnlyAttempted: () => 'Only attempted',
    showOnlyCompleted: () => 'Only completed',
  };

  it('emits a setters part when setter array is non-empty', () => {
    expect(getBaseFilterParts({ setter: ['alice', 'bob'] }, mockGrades, extendedLabels)).toEqual(['2 setters']);
  });

  it('omits setters part when array is empty', () => {
    expect(getBaseFilterParts({ setter: [] }, mockGrades, extendedLabels)).toEqual([]);
  });

  it('emits gradeAccuracy part', () => {
    expect(getBaseFilterParts({ gradeAccuracy: '0.1' }, mockGrades, extendedLabels)).toEqual(['±0.1']);
  });

  it('emits tallOnly and wideOnly parts', () => {
    expect(getBaseFilterParts({ onlyTallClimbs: true, onlyWideClimbs: true }, mockGrades, extendedLabels)).toEqual([
      'Tall only',
      'Wide only',
    ]);
  });

  it('emits status part only for drafts/projects', () => {
    expect(getBaseFilterParts({ status: 'drafts' }, mockGrades, extendedLabels)).toEqual(['Status: drafts']);
    expect(getBaseFilterParts({ status: 'projects' }, mockGrades, extendedLabels)).toEqual(['Status: projects']);
  });

  it('omits status part for any and established', () => {
    expect(getBaseFilterParts({ status: 'any' }, mockGrades, extendedLabels)).toEqual([]);
    expect(getBaseFilterParts({ status: 'established' }, mockGrades, extendedLabels)).toEqual([]);
  });

  it('emits personal progress parts when flags set', () => {
    expect(
      getBaseFilterParts(
        {
          hideAttempted: true,
          hideCompleted: true,
          showOnlyAttempted: true,
          showOnlyCompleted: true,
        },
        mockGrades,
        extendedLabels,
      ),
    ).toEqual(['Hide attempted', 'Hide completed', 'Only attempted', 'Only completed']);
  });

  it('omits extended parts when corresponding labels are not provided', () => {
    // labels here only has the original 6 callbacks — no extended ones.
    expect(
      getBaseFilterParts(
        {
          setter: ['alice'],
          gradeAccuracy: '0.1',
          onlyTallClimbs: true,
          onlyWideClimbs: true,
          status: 'drafts',
          hideAttempted: true,
          hideCompleted: true,
          showOnlyAttempted: true,
          showOnlyCompleted: true,
        },
        mockGrades,
        labels,
      ),
    ).toEqual([]);
  });
});

describe('formatFilterSummary', () => {
  it('returns null when no parts', () => {
    expect(formatFilterSummary([], labels)).toBeNull();
  });

  it('joins single part', () => {
    expect(formatFilterSummary(['V4+'], labels)).toBe('V4+');
  });

  it('joins two parts with middle dot', () => {
    expect(formatFilterSummary(['V4+', '5+ ascents'], labels)).toBe('V4+ · 5+ ascents');
  });

  it('truncates at 2 parts by default and shows remainder', () => {
    const parts = ['V4+', 'Quality', '25+ ascents', '3+ stars'];
    expect(formatFilterSummary(parts, labels)).toBe('V4+ · Quality · +2 more');
  });

  it('respects custom maxParts', () => {
    const parts = ['V4+', 'Quality', '25+ ascents'];
    expect(formatFilterSummary(parts, labels, 1)).toBe('V4+ · +2 more');
  });

  it('shows all parts when count equals maxParts', () => {
    const parts = ['V4+', 'Quality', '25+ ascents'];
    expect(formatFilterSummary(parts, labels, 3)).toBe('V4+ · Quality · 25+ ascents');
  });

  it('shows all parts when maxParts is null (no limit)', () => {
    const parts = ['V4+', 'Quality', '25+ ascents', '3+ stars'];
    expect(formatFilterSummary(parts, labels, null)).toBe('V4+ · Quality · 25+ ascents · 3+ stars');
  });

  describe('character-budget mode (maxChars)', () => {
    it('keeps every part when the joined string fits the budget', () => {
      const parts = ['V4+', 'Quality'];
      // "V4+ · Quality" is 13 chars, under 20.
      expect(formatFilterSummary(parts, labels, null, 20)).toBe('V4+ · Quality');
    });

    it('truncates with "+N more" once adding the next part would exceed the budget', () => {
      const parts = ['V4+', 'Quality', '25+ ascents', '3+ stars'];
      // "V4+ · Quality" is 13 chars; adding " · 25+ ascents" would reach 27 > 20.
      expect(formatFilterSummary(parts, labels, null, 20)).toBe('V4+ · Quality · +2 more');
    });

    it('always keeps the first part even when it alone exceeds the budget', () => {
      const parts = ['A very long single filter part', 'Quality', '3+ stars'];
      expect(formatFilterSummary(parts, labels, null, 5)).toBe('A very long single filter part · +2 more');
    });

    it('includes a lone trailing part in full instead of "+1 more"', () => {
      const parts = ['V4+', 'Quality', '3+ stars'];
      // "V4+ · Quality" is 13 chars; adding " · 3+ stars" reaches 24 > 14, but the
      // single remaining part is shown rather than a same-length "+1 more".
      expect(formatFilterSummary(parts, labels, null, 14)).toBe('V4+ · Quality · 3+ stars');
    });

    it('takes precedence over maxParts', () => {
      const parts = ['V4+', 'Quality', '25+ ascents', '3+ stars'];
      // maxParts=1 would yield "V4+ · +3 more"; the char budget fits two parts.
      expect(formatFilterSummary(parts, labels, 1, 20)).toBe('V4+ · Quality · +2 more');
    });

    it('returns null for no parts regardless of budget', () => {
      expect(formatFilterSummary([], labels, null, 20)).toBeNull();
    });
  });
});
