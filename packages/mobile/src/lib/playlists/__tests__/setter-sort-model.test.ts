// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  DEFAULT_SETTER_SORT,
  SETTER_SORT_MEMORY_KEY,
  SETTER_SORT_OPTIONS,
  setterSortModel,
} from '../setter-sort-model';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

describe('setter page sorts', () => {
  it('opens on Newest first, and drops Popular', () => {
    expect(DEFAULT_SETTER_SORT).toEqual({ sortBy: 'creation', sortOrder: 'desc' });
    expect(SETTER_SORT_OPTIONS).toEqual(['creation', 'difficulty', 'quality', 'ascents', 'name', 'random']);
    expect(setterSortModel.isOption('popular')).toBe(false);
  });

  it('opens each key on its own direction', () => {
    expect(setterSortModel.patchFor('creation')).toEqual({ sortBy: 'creation', sortOrder: 'desc' });
    expect(setterSortModel.patchFor('difficulty')).toEqual({ sortBy: 'difficulty', sortOrder: 'asc' });
    expect(setterSortModel.patchFor('quality')).toEqual({ sortBy: 'quality', sortOrder: 'desc' });
    expect(setterSortModel.patchFor('ascents')).toEqual({ sortBy: 'ascents', sortOrder: 'desc' });
    expect(setterSortModel.patchFor('name')).toEqual({ sortBy: 'name', sortOrder: 'asc' });
    expect(setterSortModel.patchFor('random').sortSeed).toMatch(/^\d+$/);
  });

  it('gives Newest two directions and Random one', () => {
    expect(setterSortModel.hasDirection('creation')).toBe(true);
    expect(setterSortModel.hasDirection('random')).toBe(false);
    expect(setterSortModel.isShuffle('random')).toBe(true);
  });

  it('words Newest by its direction', () => {
    const { result } = renderHook(() => setterSortModel.useLabels());
    expect(result.current.resting).toBe('mobile.filter.sort.creation');
    expect(result.current.directionLabel('creation', 'desc')).toBe('mobile.filter.sortDirection.creation.desc');
    expect(result.current.directionLabel('creation', 'asc')).toBe('mobile.filter.sortDirection.creation.asc');
  });

  it('shares one remembered sort across every setter page', () => {
    expect(SETTER_SORT_MEMORY_KEY).toBe('setter-pages');
  });
});
