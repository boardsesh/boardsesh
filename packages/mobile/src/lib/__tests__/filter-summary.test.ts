import { describe, it, expect } from 'vitest';
import type { Grade } from '@boardsesh/shared-schema';
import { getFilterSummary, buildClimbFilterSummary } from '../filter-summary';
import { DEFAULT_FILTERS, type ClimbFilters } from '../climb-filter-types';

const mockGrades: Grade[] = [
  { difficultyId: 1, name: 'V0' },
  { difficultyId: 5, name: 'V2' },
  { difficultyId: 10, name: 'V4' },
  { difficultyId: 15, name: 'V6' },
  { difficultyId: 20, name: 'V8' },
];

const text = (value: unknown) => (typeof value === 'string' || typeof value === 'number' ? String(value) : '');

const mockT = ((key: string, options?: Record<string, unknown>) => {
  const translations: Record<string, string> = {
    'mobile.filter.title': 'Filters',
    'mobile.filter.sort.ascents': 'Ascents',
    'mobile.filter.sort.quality': 'Quality',
    'mobile.filter.sort.difficulty': 'Difficulty',
    'mobile.filter.sort.name': 'Name',
    'mobile.filter.sort.popular': 'Popular',
    'mobile.filter.sort.creation': 'Newest',
    'mobile.filter.climbType.all': 'All',
    'mobile.filter.climbType.boulders': 'Boulders',
    'mobile.filter.climbType.routes': 'Routes',
  };
  if (translations[key]) return translations[key];

  if (key === 'mobile.search.gradeRange') return `${text(options?.min)}–${text(options?.max)}`;
  if (key === 'mobile.search.gradeMin') return `${text(options?.grade)}+`;
  if (key === 'mobile.search.gradeMax') return `≤${text(options?.grade)}`;
  if (key === 'mobile.search.ascents') return `${text(options?.count)}+ 🧗`;
  if (key === 'mobile.search.rating') return `${text(options?.count)}+ ⭐`;
  if (key === 'mobile.search.more') return `+${text(options?.count)} more`;
  if (key === 'mobile.search.setterName') return `By ${text(options?.setter)}`;
  if (key === 'mobile.search.settersCount') return `${text(options?.count)} setters`;

  return key;
}) as unknown as Parameters<typeof getFilterSummary>[3];

describe('getFilterSummary', () => {
  it('returns fallback label when no filters are active', () => {
    expect(getFilterSummary(DEFAULT_FILTERS, '', mockGrades, mockT)).toBe('Filters');
  });

  it('shows search text in quotes', () => {
    expect(getFilterSummary(DEFAULT_FILTERS, 'crimp', mockGrades, mockT)).toBe('"crimp"');
  });

  it('shows grade range when both min and max are set', () => {
    const filters: ClimbFilters = { ...DEFAULT_FILTERS, minGrade: 5, maxGrade: 15 };
    expect(getFilterSummary(filters, '', mockGrades, mockT)).toBe('V2–V6');
  });

  it('shows min grade with plus sign', () => {
    const filters: ClimbFilters = { ...DEFAULT_FILTERS, minGrade: 10 };
    expect(getFilterSummary(filters, '', mockGrades, mockT)).toBe('V4+');
  });

  it('shows max grade with the ≤ prefix', () => {
    const filters: ClimbFilters = { ...DEFAULT_FILTERS, maxGrade: 15 };
    expect(getFilterSummary(filters, '', mockGrades, mockT)).toBe('≤V6');
  });

  it('shows non-default sort label', () => {
    const filters: ClimbFilters = { ...DEFAULT_FILTERS, sortBy: 'quality' };
    expect(getFilterSummary(filters, '', mockGrades, mockT)).toBe('Quality');
  });

  it('joins two parts with middle dot', () => {
    const filters: ClimbFilters = { ...DEFAULT_FILTERS, minGrade: 10, minAscents: 25 };
    expect(getFilterSummary(filters, '', mockGrades, mockT)).toBe('V4+ · 25+ 🧗');
  });

  it('truncates at 2 parts and shows remainder count', () => {
    const filters: ClimbFilters = {
      ...DEFAULT_FILTERS,
      sortBy: 'quality',
      minGrade: 10,
      minAscents: 25,
      minRating: 3,
    };
    const result = getFilterSummary(filters, '', mockGrades, mockT);
    expect(result).toBe('V4+ · Quality · +2 more');
  });

  it('falls back to difficultyId when grade name not found', () => {
    const filters: ClimbFilters = { ...DEFAULT_FILTERS, minGrade: 999 };
    expect(getFilterSummary(filters, '', mockGrades, mockT)).toBe('#999+');
  });

  it('skips grade parts when grades data is undefined', () => {
    const filters: ClimbFilters = { ...DEFAULT_FILTERS, minGrade: 10, minAscents: 5 };
    expect(getFilterSummary(filters, '', undefined, mockT)).toBe('5+ 🧗');
  });

  it('includes search text as first part before filter parts', () => {
    const filters: ClimbFilters = { ...DEFAULT_FILTERS, minGrade: 10 };
    expect(getFilterSummary(filters, 'test', mockGrades, mockT)).toBe('"test" · V4+');
  });

  it('shows the beta videos filter part when enabled', () => {
    const filters: ClimbFilters = { ...DEFAULT_FILTERS, onlyWithBetaVideos: true };
    expect(getFilterSummary(filters, '', mockGrades, mockT)).toBe('mobile.filter.betaVideosShort');
  });

  it('shows the translated setter name when exactly one setter is selected', () => {
    const filters: ClimbFilters = { ...DEFAULT_FILTERS, setter: ['marco'] };
    expect(getFilterSummary(filters, '', mockGrades, mockT)).toBe('By marco');
  });

  it('shows the setter count when multiple setters are selected', () => {
    const filters: ClimbFilters = { ...DEFAULT_FILTERS, setter: ['marco', 'jules'] };
    expect(getFilterSummary(filters, '', mockGrades, mockT)).toBe('2 setters');
  });

  it('shows explicit climb type filters', () => {
    const filters: ClimbFilters = { ...DEFAULT_FILTERS, boulders: true, routes: false };
    expect(getFilterSummary(filters, '', mockGrades, mockT)).toBe('Boulders');
  });
});

describe('buildClimbFilterSummary', () => {
  const more = (count: number) => `+${count} more`;

  it('returns null when there are no filter parts', () => {
    expect(buildClimbFilterSummary({ labels: [], isMaterial: false, maxChars: 28, more })).toBeNull();
    expect(buildClimbFilterSummary({ labels: [], isMaterial: true, maxChars: 28, more })).toBeNull();
  });

  it('Material caps at 2 parts then "+N more"', () => {
    const labels = ['V4+', 'Quality', '3+ ⭐', '5+ 🧗'];
    expect(buildClimbFilterSummary({ labels, isMaterial: true, maxChars: 999, more })).toBe('V4+ · Quality · +2 more');
  });

  it('glass fits whole parts within the character budget then "+N more"', () => {
    const labels = ['V4+', 'Quality', '25+ ascents', '3+ stars'];
    // "V4+ · Quality" is 13 chars; "25+ ascents" would push it to 27 > 20.
    expect(buildClimbFilterSummary({ labels, isMaterial: false, maxChars: 20, more })).toBe('V4+ · Quality · +2 more');
  });

  it('glass keeps every part when the summary fits the budget', () => {
    const labels = ['V4+', 'Quality'];
    expect(buildClimbFilterSummary({ labels, isMaterial: false, maxChars: 28, more })).toBe('V4+ · Quality');
  });

  it('glass budget can show more parts than the Material 2-part cap', () => {
    const labels = ['V4+', 'Quality', '3+ ⭐'];
    // Material truncates to 2; glass fits all three within 28 chars.
    expect(buildClimbFilterSummary({ labels, isMaterial: true, maxChars: 28, more })).toBe('V4+ · Quality · +1 more');
    expect(buildClimbFilterSummary({ labels, isMaterial: false, maxChars: 28, more })).toBe('V4+ · Quality · 3+ ⭐');
  });
});
