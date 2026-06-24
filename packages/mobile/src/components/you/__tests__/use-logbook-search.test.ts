// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LOGBOOK_FILTERS, DEFAULT_LOGBOOK_SORT, type LogbookFilterState } from '@boardsesh/logbook';

// Hydration + persistence go through the prefs store; mock it so the reducer's
// hydrate/save behaviour (including the apply-before-hydrate race) is unit-testable.
vi.mock('../../../lib/logbook-prefs-store', () => ({
  loadLogbookPrefs: vi.fn(() => Promise.resolve(null)),
  saveLogbookPrefs: vi.fn(() => Promise.resolve()),
}));

import { loadLogbookPrefs, saveLogbookPrefs, type StoredLogbookPrefs } from '../../../lib/logbook-prefs-store';
import { countActiveLogbookFilters, useLogbookSearch } from '../use-logbook-search';

const withFilters = (overrides: Partial<LogbookFilterState>): LogbookFilterState => ({
  ...DEFAULT_LOGBOOK_FILTERS,
  ...overrides,
});

describe('countActiveLogbookFilters', () => {
  it('is 0 for the default filters', () => {
    expect(countActiveLogbookFilters(DEFAULT_LOGBOOK_FILTERS)).toBe(0);
  });

  it('counts a narrowed status (sends-only or attempts-only) as one', () => {
    expect(countActiveLogbookFilters(withFilters({ includeAttempts: false }))).toBe(1);
    expect(countActiveLogbookFilters(withFilters({ includeSends: false }))).toBe(1);
  });

  it('counts flash-only as one (the flash+no-sends edge still counts via status)', () => {
    expect(countActiveLogbookFilters(withFilters({ flashOnly: true }))).toBe(1);
    // Sends excluded + flashOnly: status narrowed (1) + flash (1).
    expect(countActiveLogbookFilters(withFilters({ includeSends: false, flashOnly: true }))).toBe(2);
  });

  it('counts a grade bound (min and/or max) as one', () => {
    expect(countActiveLogbookFilters(withFilters({ minGrade: 12 }))).toBe(1);
    expect(countActiveLogbookFilters(withFilters({ minGrade: 12, maxGrade: 20 }))).toBe(1);
  });

  it('counts a date bound as one', () => {
    expect(countActiveLogbookFilters(withFilters({ fromDate: '2026-01-01' }))).toBe(1);
  });

  it('counts the angle range as ONE even when both bounds are narrowed', () => {
    expect(countActiveLogbookFilters(withFilters({ angleRange: [20, 50] }))).toBe(1);
    expect(countActiveLogbookFilters(withFilters({ angleRange: [20, 70] }))).toBe(1);
  });

  it('counts benchmarks-only as one', () => {
    expect(countActiveLogbookFilters(withFilters({ benchmarkOnly: true }))).toBe(1);
  });

  it('sums independent active filters', () => {
    // status (attempts-only) + flash + grade + angle = 4
    expect(
      countActiveLogbookFilters(
        withFilters({ includeAttempts: false, flashOnly: true, minGrade: 12, angleRange: [20, 50] }),
      ),
    ).toBe(4);
  });
});

const flushHydration = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

describe('useLogbookSearch', () => {
  beforeEach(() => {
    vi.mocked(loadLogbookPrefs).mockReset().mockResolvedValue(null);
    vi.mocked(saveLogbookPrefs).mockReset().mockResolvedValue(undefined);
  });

  it('gates until hydration, then applies the persisted prefs', async () => {
    vi.mocked(loadLogbookPrefs).mockResolvedValueOnce({
      filters: { ...DEFAULT_LOGBOOK_FILTERS, benchmarkOnly: true },
      sort: { ...DEFAULT_LOGBOOK_SORT, mode: 'preset', preset: 'hardest' },
    });
    const { result } = renderHook(() => useLogbookSearch());

    expect(result.current.hydrated).toBe(false);
    await flushHydration();

    expect(result.current.hydrated).toBe(true);
    expect(result.current.filters.benchmarkOnly).toBe(true);
    expect(result.current.sort.preset).toBe('hardest');
  });

  it('persists filter/sort changes once hydrated', async () => {
    const { result } = renderHook(() => useLogbookSearch());
    await flushHydration();
    vi.mocked(saveLogbookPrefs).mockClear();

    await act(async () => {
      result.current.setPreset('hardest');
    });

    expect(saveLogbookPrefs).toHaveBeenCalledWith(
      expect.objectContaining({ sort: expect.objectContaining({ preset: 'hardest' }) }),
    );
  });

  it('keeps a change applied before hydration resolves (no clobber)', async () => {
    let resolveLoad: (value: StoredLogbookPrefs | null) => void = () => {};
    vi.mocked(loadLogbookPrefs).mockReturnValueOnce(
      new Promise<StoredLogbookPrefs | null>((resolve) => {
        resolveLoad = resolve;
      }),
    );
    const { result } = renderHook(() => useLogbookSearch());

    // User applies attempts-only before persisted prefs finish loading.
    await act(async () => {
      result.current.apply(
        { ...DEFAULT_LOGBOOK_FILTERS, includeSends: false, includeAttempts: true },
        DEFAULT_LOGBOOK_SORT,
      );
    });
    expect(result.current.hydrated).toBe(false);

    // The persisted prefs (a different set) now resolve — they must NOT overwrite.
    await act(async () => {
      resolveLoad({ filters: { ...DEFAULT_LOGBOOK_FILTERS, benchmarkOnly: true }, sort: DEFAULT_LOGBOOK_SORT });
      await Promise.resolve();
    });

    expect(result.current.hydrated).toBe(true);
    expect(result.current.filters.includeSends).toBe(false);
    expect(result.current.filters.benchmarkOnly).toBe(false);
  });

  it('reset restores defaults and keeps the gate open', async () => {
    vi.mocked(loadLogbookPrefs).mockResolvedValueOnce({
      filters: { ...DEFAULT_LOGBOOK_FILTERS, benchmarkOnly: true },
      sort: DEFAULT_LOGBOOK_SORT,
    });
    const { result } = renderHook(() => useLogbookSearch());
    await flushHydration();
    expect(result.current.filters.benchmarkOnly).toBe(true);

    await act(async () => {
      result.current.reset();
    });

    expect(result.current.filters).toEqual(DEFAULT_LOGBOOK_FILTERS);
    expect(result.current.hydrated).toBe(true);
  });
});
