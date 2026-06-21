import { describe, it, expect } from 'vitest';
import type { TFunction } from 'i18next';
import { buildFilterLabels, buildSortLabel, formatSettersLabel } from '../filter-labels';

// Mirrors the pattern from filter-summary.test.ts: the mock t returns the key
// (with interpolated placeholders for readable assertions) or a formatted string
// for parametric keys.
const text = (value: unknown) => (typeof value === 'string' || typeof value === 'number' ? String(value) : '');

const mockT = ((key: string, opts?: Record<string, unknown>) => {
  if (key === 'mobile.search.gradeRange') return `${text(opts?.min)}–${text(opts?.max)}`;
  if (key === 'mobile.search.gradeMin') return `${text(opts?.grade)}+`;
  if (key === 'mobile.search.gradeMax') return `≤${text(opts?.grade)}`;
  if (key === 'mobile.search.ascents') return `${text(opts?.count)}+ 🧗`;
  if (key === 'mobile.search.rating') return `${text(opts?.count)}+ ⭐`;
  if (key === 'mobile.search.more') return `+${text(opts?.count)} more`;
  if (key === 'mobile.search.setterName') return `By ${text(opts?.setter)}`;
  if (key === 'mobile.search.settersCount') return `${text(opts?.count)} setters`;
  return key;
}) as unknown as TFunction<'climbs'>;

describe('buildFilterLabels', () => {
  const labels = buildFilterLabels(mockT);

  it('gradeRange passes both bounds', () => {
    expect(labels.gradeRange('V0', 'V8')).toBe('V0–V8');
  });

  it('gradeMin passes the grade arg', () => {
    expect(labels.gradeMin('V4')).toBe('V4+');
  });

  it('gradeMax passes the grade arg', () => {
    expect(labels.gradeMax('V6')).toBe('≤V6');
  });

  it('ascents passes count', () => {
    expect(labels.ascents(10)).toBe('10+ 🧗');
  });

  it('rating passes count', () => {
    expect(labels.rating(3)).toBe('3+ ⭐');
  });

  it('more passes count', () => {
    expect(labels.more(2)).toBe('+2 more');
  });

  it('setters uses mobile.search.settersCount (not mobile.search.setters)', () => {
    // The key rename is the silent-typo risk the doc comment warns about.
    expect(labels.setters(5)).toBe('5 setters');
  });

  it('formats one setter with the translated By label', () => {
    expect(formatSettersLabel(['marco'], labels, mockT)).toBe('By marco');
  });

  it('formats multiple setters by count', () => {
    expect(formatSettersLabel(['marco', 'jules'], labels, mockT)).toBe('2 setters');
  });

  it('gradeAccuracy resolves the bucket suffix — off', () => {
    // gradeAccuracyBucket('0') === 'off'
    expect(labels.gradeAccuracy('0')).toBe('mobile.filter.accuracy.off');
  });

  it('gradeAccuracy resolves the bucket suffix — loose', () => {
    expect(labels.gradeAccuracy('0.2')).toBe('mobile.filter.accuracy.loose');
  });

  it('gradeAccuracy resolves the bucket suffix — moderate', () => {
    expect(labels.gradeAccuracy('0.1')).toBe('mobile.filter.accuracy.moderate');
  });

  it('gradeAccuracy resolves the bucket suffix — tight', () => {
    expect(labels.gradeAccuracy('0.05')).toBe('mobile.filter.accuracy.tight');
  });

  it('tallOnly uses the no-"only" summary form mobile.filter.tallClimbs', () => {
    expect(labels.tallOnly()).toBe('mobile.filter.tallClimbs');
  });

  it('wideOnly uses the no-"only" summary form mobile.filter.wideClimbs', () => {
    expect(labels.wideOnly()).toBe('mobile.filter.wideClimbs');
  });

  it('betaOnly uses the no-"only" summary form mobile.filter.betaVideosShort', () => {
    expect(labels.betaOnly()).toBe('mobile.filter.betaVideosShort');
  });

  it('status appends the kind suffix', () => {
    expect(labels.status('drafts')).toBe('mobile.filter.status.drafts');
    expect(labels.status('established')).toBe('mobile.filter.status.established');
    expect(labels.status('projects')).toBe('mobile.filter.status.projects');
  });

  it('hideAttempted uses mobile.filter.progress.hideAttempted', () => {
    expect(labels.hideAttempted()).toBe('mobile.filter.progress.hideAttempted');
  });

  it('hideCompleted uses mobile.filter.progress.hideCompleted', () => {
    expect(labels.hideCompleted()).toBe('mobile.filter.progress.hideCompleted');
  });

  it('showOnlyAttempted uses mobile.filter.progress.onlyAttempted', () => {
    expect(labels.showOnlyAttempted()).toBe('mobile.filter.progress.onlyAttempted');
  });

  it('showOnlyCompleted uses mobile.filter.progress.onlyCompleted', () => {
    expect(labels.showOnlyCompleted()).toBe('mobile.filter.progress.onlyCompleted');
  });

  it('returns all required keys (no missing fields)', () => {
    // Ensures Required<FilterSummaryLabels> is fully populated.
    const keys: Array<keyof ReturnType<typeof buildFilterLabels>> = [
      'gradeRange',
      'gradeMin',
      'gradeMax',
      'ascents',
      'rating',
      'more',
      'setters',
      'gradeAccuracy',
      'tallOnly',
      'wideOnly',
      'betaOnly',
      'status',
      'hideAttempted',
      'hideCompleted',
      'showOnlyAttempted',
      'showOnlyCompleted',
    ];
    for (const key of keys) {
      expect(typeof labels[key]).toBe('function');
    }
  });
});

describe('buildSortLabel', () => {
  const sortLabel = buildSortLabel(mockT);

  it('maps every valid SortOption to its i18n key', () => {
    expect(sortLabel('ascents')).toBe('mobile.filter.sort.ascents');
    expect(sortLabel('quality')).toBe('mobile.filter.sort.quality');
    expect(sortLabel('difficulty')).toBe('mobile.filter.sort.difficulty');
    expect(sortLabel('name')).toBe('mobile.filter.sort.name');
    expect(sortLabel('popular')).toBe('mobile.filter.sort.popular');
    expect(sortLabel('creation')).toBe('mobile.filter.sort.creation');
  });

  it('returns undefined for an unknown sort string', () => {
    expect(sortLabel('unknown_sort')).toBeUndefined();
  });
});
