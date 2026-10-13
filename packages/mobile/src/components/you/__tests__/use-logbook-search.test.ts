// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LOGBOOK_FILTERS,
  DEFAULT_LOGBOOK_SORT,
  filtersForStatusSegment,
  logbookSortFor,
  type LogbookFilterState,
} from '@boardsesh/logbook';

// Hydration + persistence go through the prefs store; mock it so the reducer's
// hydrate/save behaviour (including the change-before-hydrate race) is unit-testable.
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

  it('does not count the sends+attempts default status', () => {
    // Sends+attempts is the resting state, so it adds nothing.
    expect(countActiveLogbookFilters(DEFAULT_LOGBOOK_FILTERS)).toBe(0);
  });

  it('counts a non-default status (sends-only or attempts-only) as one', () => {
    // Narrowing to sends-only is off the sends+attempts default.
    expect(countActiveLogbookFilters(withFilters({ includeAttempts: false }))).toBe(1);
    // attempts-only.
    expect(countActiveLogbookFilters(withFilters({ includeSends: false }))).toBe(1);
  });

  it('counts Flashes as ONE status, however it is stored', () => {
    // The segment's own shape: sends only + flash only.
    expect(countActiveLogbookFilters(withFilters({ includeAttempts: false, flashOnly: true }))).toBe(1);
    // An older stored "both + flash only" also reads as Flashes.
    expect(countActiveLogbookFilters(withFilters({ flashOnly: true }))).toBe(1);
    // A stray flashOnly under attempts-only is just Attempts.
    expect(
      countActiveLogbookFilters(withFilters({ includeSends: false, includeAttempts: true, flashOnly: true })),
    ).toBe(1);
  });

  it('counts a grade bound (min and/or max) as one', () => {
    expect(countActiveLogbookFilters(withFilters({ minGrade: 12 }))).toBe(1);
    expect(countActiveLogbookFilters(withFilters({ minGrade: 12, maxGrade: 20 }))).toBe(1);
  });

  it('counts a date window as one', () => {
    expect(countActiveLogbookFilters(withFilters({ dateWindow: 'month' }))).toBe(1);
    expect(countActiveLogbookFilters(withFilters({ dateWindow: 'last7' }))).toBe(1);
    expect(
      countActiveLogbookFilters(withFilters({ dateWindow: 'custom', fromDate: '2026-01-01', toDate: '2026-02-01' })),
    ).toBe(1);
  });

  it('does not count Any time, or a Custom window with no date picked', () => {
    // A leftover range under Any time narrows nothing.
    expect(countActiveLogbookFilters(withFilters({ dateWindow: 'any', fromDate: '2026-01-01' }))).toBe(0);
    expect(countActiveLogbookFilters(withFilters({ dateWindow: 'custom' }))).toBe(0);
  });

  it('counts a board as one, with or without layouts', () => {
    expect(countActiveLogbookFilters(withFilters({ boardType: 'kilter' }))).toBe(1);
    expect(countActiveLogbookFilters(withFilters({ boardType: 'kilter', layoutIds: [1, 8] }))).toBe(1);
  });

  it('counts stars and setters as one each', () => {
    expect(countActiveLogbookFilters(withFilters({ minQuality: 3 }))).toBe(1);
    expect(countActiveLogbookFilters(withFilters({ setterUsernames: ['jwebb', 'alex'] }))).toBe(1);
  });

  it('counts the angle range as ONE even when both bounds are narrowed', () => {
    expect(countActiveLogbookFilters(withFilters({ angleRange: [20, 50] }))).toBe(1);
    expect(countActiveLogbookFilters(withFilters({ angleRange: [20, 70] }))).toBe(1);
  });

  it('counts benchmarks-only as one', () => {
    expect(countActiveLogbookFilters(withFilters({ benchmarkOnly: true }))).toBe(1);
  });

  it('sums independent active filters', () => {
    // status (Flashes) + grade + angle = 3
    expect(
      countActiveLogbookFilters(
        withFilters({ includeAttempts: false, flashOnly: true, minGrade: 12, angleRange: [20, 50] }),
      ),
    ).toBe(3);
    // Every dimension at once = 8.
    expect(
      countActiveLogbookFilters(
        withFilters({
          includeSends: false,
          minGrade: 12,
          angleRange: [20, 50],
          dateWindow: 'year',
          boardType: 'tension',
          minQuality: 4,
          setterUsernames: ['alex'],
          benchmarkOnly: true,
        }),
      ),
    ).toBe(8);
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
      result.current.setSort(logbookSortFor('grade', 'desc'));
    });

    expect(saveLogbookPrefs).toHaveBeenCalledWith(
      expect.objectContaining({ sort: expect.objectContaining({ preset: 'hardest' }) }),
    );
  });

  it('setFilters merges a partial patch and persists, leaving sort and name untouched', async () => {
    const { result } = renderHook(() => useLogbookSearch());
    await flushHydration();
    // A name + a preset are in place before the partial filter patch.
    await act(async () => {
      result.current.setName('crimps');
      result.current.setSort(logbookSortFor('grade', 'desc'));
    });
    vi.mocked(saveLogbookPrefs).mockClear();

    await act(async () => {
      result.current.setFilters({ minGrade: 12, maxGrade: 20 });
    });

    // Only the named fields changed; the rest of the filter set stays default.
    expect(result.current.filters.minGrade).toBe(12);
    expect(result.current.filters.maxGrade).toBe(20);
    expect(result.current.filters.includeSends).toBe(true);
    expect(result.current.filters.benchmarkOnly).toBe(false);
    // Sort and name are not touched by setFilters.
    expect(result.current.sort.mode).toBe('preset');
    expect(result.current.sort.preset).toBe('hardest');
    expect(result.current.name).toBe('crimps');
    // The patch persisted.
    expect(saveLogbookPrefs).toHaveBeenCalledWith(
      expect.objectContaining({ filters: expect.objectContaining({ minGrade: 12, maxGrade: 20 }) }),
    );
  });

  it('setSort commits a Sort by + Order choice and persists it, leaving filters and name alone', async () => {
    const { result } = renderHook(() => useLogbookSearch());
    await flushHydration();
    await act(async () => {
      result.current.setName('crimps');
      result.current.setFilters({ minGrade: 12 });
    });
    vi.mocked(saveLogbookPrefs).mockClear();

    const nameAsc = logbookSortFor('climbName', 'asc');
    await act(async () => {
      result.current.setSort(nameAsc);
    });

    expect(result.current.sort).toEqual(nameAsc);
    expect(result.current.filters.minGrade).toBe(12);
    expect(result.current.name).toBe('crimps');
    expect(saveLogbookPrefs).toHaveBeenCalledWith(expect.objectContaining({ sort: nameAsc }));
  });

  it('setFilters carries the new dimensions (status segment, window, board, stars, setters)', async () => {
    const { result } = renderHook(() => useLogbookSearch());
    await flushHydration();

    await act(async () => {
      result.current.setFilters({
        ...filtersForStatusSegment('flashes'),
        dateWindow: 'last3months',
        boardType: 'kilter',
        layoutIds: [1],
        minQuality: 4,
        setterUsernames: ['jwebb'],
      });
    });

    expect(result.current.filters).toEqual({
      ...DEFAULT_LOGBOOK_FILTERS,
      includeSends: true,
      includeAttempts: false,
      flashOnly: true,
      dateWindow: 'last3months',
      boardType: 'kilter',
      layoutIds: [1],
      minQuality: 4,
      setterUsernames: ['jwebb'],
    });
    expect(countActiveLogbookFilters(result.current.filters)).toBe(5);
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
      result.current.setFilters({ includeSends: false, includeAttempts: true });
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

  it('keeps a setFilters change applied before hydration resolves (no clobber)', async () => {
    let resolveLoad: (value: StoredLogbookPrefs | null) => void = () => {};
    vi.mocked(loadLogbookPrefs).mockReturnValueOnce(
      new Promise<StoredLogbookPrefs | null>((resolve) => {
        resolveLoad = resolve;
      }),
    );
    const { result } = renderHook(() => useLogbookSearch());

    // A facet chip live-commits via setFilters before persisted prefs finish loading.
    await act(async () => {
      result.current.setFilters({ benchmarkOnly: true });
    });
    expect(result.current.hydrated).toBe(false);

    // The persisted prefs (a different set) now resolve — they must NOT overwrite.
    await act(async () => {
      resolveLoad({ filters: { ...DEFAULT_LOGBOOK_FILTERS, minGrade: 12 }, sort: DEFAULT_LOGBOOK_SORT });
      await Promise.resolve();
    });

    expect(result.current.hydrated).toBe(true);
    expect(result.current.filters.benchmarkOnly).toBe(true);
    expect(result.current.filters.minGrade).toBe('');
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

describe("useLogbookSearch on someone else's logbook (persist: false)", () => {
  beforeEach(() => {
    vi.mocked(loadLogbookPrefs)
      .mockReset()
      .mockResolvedValue({
        filters: { ...DEFAULT_LOGBOOK_FILTERS, benchmarkOnly: true },
        sort: DEFAULT_LOGBOOK_SORT,
      });
    vi.mocked(saveLogbookPrefs).mockReset().mockResolvedValue(undefined);
  });

  it('opens at once on defaults, never reads your saved filters, and never writes its own', async () => {
    const { result } = renderHook(() => useLogbookSearch({ persist: false }));
    expect(result.current.hydrated).toBe(true);
    await flushHydration();
    expect(loadLogbookPrefs).not.toHaveBeenCalled();
    expect(result.current.filters).toEqual(DEFAULT_LOGBOOK_FILTERS);

    await act(async () => {
      result.current.setFilters({ boardType: 'kilter', setterUsernames: ['alex'] });
      result.current.setSort(logbookSortFor('grade', 'desc'));
    });
    await act(async () => {
      result.current.reset();
    });
    expect(saveLogbookPrefs).not.toHaveBeenCalled();
  });

  it('reads persistence once at mount, so a later flip cannot save defaults over your prefs', async () => {
    const { result, rerender } = renderHook(({ persist }) => useLogbookSearch({ persist }), {
      initialProps: { persist: false },
    });
    await act(async () => {
      result.current.setFilters({ minQuality: 3 });
    });
    rerender({ persist: true });
    await flushHydration();
    expect(loadLogbookPrefs).not.toHaveBeenCalled();
    expect(saveLogbookPrefs).not.toHaveBeenCalled();
  });

  it('still hydrates and saves your own logbook', async () => {
    const { result } = renderHook(() => useLogbookSearch({ persist: true }));
    expect(result.current.hydrated).toBe(false);
    await flushHydration();
    expect(result.current.filters.benchmarkOnly).toBe(true);
    vi.mocked(saveLogbookPrefs).mockClear();
    await act(async () => {
      result.current.setFilters({ minQuality: 3 });
    });
    expect(saveLogbookPrefs).toHaveBeenCalledWith(
      expect.objectContaining({ filters: expect.objectContaining({ minQuality: 3, benchmarkOnly: true }) }),
    );
  });
});
