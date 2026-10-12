import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_LOGBOOK_FILTERS, DEFAULT_LOGBOOK_SORT } from '@boardsesh/logbook';

const store = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock('../preference-store', () => ({
  getPreference: store.get,
  setPreference: store.set,
}));

import { loadLogbookPrefs, saveLogbookPrefs } from '../logbook-prefs-store';

describe('logbook-prefs-store', () => {
  beforeEach(() => {
    store.get.mockReset();
    store.set.mockReset();
  });

  it('returns null when nothing is stored', async () => {
    store.get.mockResolvedValue(null);
    expect(await loadLogbookPrefs()).toBeNull();
  });

  it('sanitizes a stored payload (clamps angle, keeps valid grade, defaults garbage sort)', async () => {
    store.get.mockResolvedValue({
      filters: { ...DEFAULT_LOGBOOK_FILTERS, angleRange: [-5, 200], minGrade: 12 },
      sort: { preset: 'bogus' },
    });
    const prefs = await loadLogbookPrefs();
    expect(prefs?.filters.angleRange).toEqual([-5, 70]);
    expect(prefs?.filters.minGrade).toBe(12);
    expect(prefs?.sort.preset).toBe('recent');
  });

  it('saves the filter/sort prefs under the logbook key', async () => {
    store.set.mockResolvedValue(undefined);
    await saveLogbookPrefs({ filters: DEFAULT_LOGBOOK_FILTERS, sort: { ...DEFAULT_LOGBOOK_SORT, preset: 'hardest' } });
    expect(store.set).toHaveBeenCalledWith(
      'logbookSearchPrefs',
      expect.objectContaining({ sort: expect.objectContaining({ preset: 'hardest' }) }),
    );
  });

  it('returns null when the storage read throws (so hydration never deadlocks)', async () => {
    store.get.mockRejectedValue(new Error('storage unavailable'));
    await expect(loadLogbookPrefs()).resolves.toBeNull();
  });

  it('keeps a never-touched legacy "both" payload on the new attempts-included default (v1 -> v3)', async () => {
    // The obsolete v1→v2 attempts-drop must NOT chain: stranding legacy users
    // on sends-only would be the opposite of the new default they never left.
    store.get.mockResolvedValue({
      version: 1,
      filters: { ...DEFAULT_LOGBOOK_FILTERS, includeSends: true, includeAttempts: true },
      sort: DEFAULT_LOGBOOK_SORT,
    });
    const prefs = await loadLogbookPrefs();
    expect(prefs?.filters.includeSends).toBe(true);
    expect(prefs?.filters.includeAttempts).toBe(true);
  });

  it('keeps a DIVERGED legacy payload verbatim, attempts included (v1 -> v3)', async () => {
    store.get.mockResolvedValue({
      version: 1,
      filters: { ...DEFAULT_LOGBOOK_FILTERS, includeSends: true, includeAttempts: true, minGrade: 12 },
      sort: DEFAULT_LOGBOOK_SORT,
    });
    const prefs = await loadLogbookPrefs();
    expect(prefs?.filters.includeAttempts).toBe(true);
    expect(prefs?.filters.minGrade).toBe(12);
  });

  it('refreshes an untouched v2 sends-only payload to the new attempts-included default (v2 -> v3)', async () => {
    store.get.mockResolvedValue({
      version: 2,
      // The v2 resting default: sends only, everything else at defaults.
      filters: {
        ...DEFAULT_LOGBOOK_FILTERS,
        includeSends: true,
        includeAttempts: false,
        angleRange: [0, 70],
      },
      sort: DEFAULT_LOGBOOK_SORT,
    });
    const prefs = await loadLogbookPrefs();
    expect(prefs?.filters.includeAttempts).toBe(true);
  });

  it('migrates partial pre-v3 payloads whose historical angle range was omitted', async () => {
    store.get.mockResolvedValue({
      version: 2,
      filters: { includeSends: true, includeAttempts: false },
      sort: DEFAULT_LOGBOOK_SORT,
    });
    const versionTwoPrefs = await loadLogbookPrefs();
    expect(versionTwoPrefs?.filters.includeAttempts).toBe(true);
    expect(versionTwoPrefs?.filters.angleRange).toEqual([-5, 70]);

    store.get.mockResolvedValue({
      filters: { includeSends: true, includeAttempts: true },
      sort: DEFAULT_LOGBOOK_SORT,
    });
    const versionlessPrefs = await loadLogbookPrefs();
    expect(versionlessPrefs?.filters.includeAttempts).toBe(true);
    expect(versionlessPrefs?.filters.angleRange).toEqual([-5, 70]);
  });

  it('keeps an explicit v2 "sends only" choice when the user diverged elsewhere', async () => {
    store.get.mockResolvedValue({
      version: 2,
      // User narrowed to a grade AND kept sends-only — a real, diverged choice.
      filters: { ...DEFAULT_LOGBOOK_FILTERS, includeSends: true, includeAttempts: false, minGrade: 12 },
      sort: DEFAULT_LOGBOOK_SORT,
    });
    const prefs = await loadLogbookPrefs();
    expect(prefs?.filters.includeAttempts).toBe(false);
    expect(prefs?.filters.minGrade).toBe(12);
  });

  it('migrates a v3 angle default without changing its status choice', async () => {
    store.get.mockResolvedValue({
      version: 3,
      filters: { ...DEFAULT_LOGBOOK_FILTERS, includeSends: true, includeAttempts: false, angleRange: [0, 70] },
      sort: DEFAULT_LOGBOOK_SORT,
    });
    const prefs = await loadLogbookPrefs();
    // v3 install that turned attempts off — respected, not re-defaulted.
    expect(prefs?.filters.includeAttempts).toBe(false);
    expect(prefs?.filters.angleRange).toEqual([-5, 70]);
  });

  it('preserves an explicit v4 zero lower bound and a pre-v4 positive lower bound', async () => {
    store.get.mockResolvedValue({
      version: 4,
      filters: { ...DEFAULT_LOGBOOK_FILTERS, angleRange: [0, 70] },
      sort: DEFAULT_LOGBOOK_SORT,
    });
    expect((await loadLogbookPrefs())?.filters.angleRange).toEqual([0, 70]);

    store.get.mockResolvedValue({
      version: 3,
      filters: { ...DEFAULT_LOGBOOK_FILTERS, angleRange: [20, 50] },
      sort: DEFAULT_LOGBOOK_SORT,
    });
    expect((await loadLogbookPrefs())?.filters.angleRange).toEqual([20, 50]);
  });

  it('stamps the schema version when saving', async () => {
    store.set.mockResolvedValue(undefined);
    await saveLogbookPrefs({ filters: DEFAULT_LOGBOOK_FILTERS, sort: DEFAULT_LOGBOOK_SORT });
    expect(store.set).toHaveBeenCalledWith('logbookSearchPrefs', expect.objectContaining({ version: 5 }));
  });

  // What a v4 build wrote: no date window, board, stars or setters.
  const v4Filters = {
    includeSends: true,
    includeAttempts: false,
    flashOnly: true,
    minGrade: 12,
    maxGrade: 20,
    fromDate: '2026-03-01',
    toDate: '2026-04-01',
    angleRange: [20, 50],
    benchmarkOnly: true,
  };

  it('migrates a v4 payload to v5 without losing a field (a saved range reads as Custom)', async () => {
    store.set.mockResolvedValue(undefined);
    const v4Sort = { ...DEFAULT_LOGBOOK_SORT, preset: 'hardest' };
    store.get.mockResolvedValue({ version: 4, filters: v4Filters, sort: v4Sort });
    const prefs = await loadLogbookPrefs();
    const expectedFilters = {
      ...v4Filters,
      dateWindow: 'custom',
      boardType: '',
      layoutIds: [],
      minQuality: '',
      setterUsernames: [],
    };
    expect(prefs).toEqual({ filters: expectedFilters, sort: v4Sort });
    // Stamped v5 straight away so the migration doesn't re-run every launch.
    expect(store.set).toHaveBeenCalledWith('logbookSearchPrefs', {
      version: 5,
      filters: expectedFilters,
      sort: v4Sort,
    });
  });

  it('reads a v4 payload without dates as Any time', async () => {
    store.get.mockResolvedValue({
      version: 4,
      filters: { ...v4Filters, fromDate: '', toDate: '' },
      sort: DEFAULT_LOGBOOK_SORT,
    });
    expect((await loadLogbookPrefs())?.filters.dateWindow).toBe('any');
  });

  it('keeps a v5 payload as saved and does not rewrite it', async () => {
    const filters = {
      ...DEFAULT_LOGBOOK_FILTERS,
      dateWindow: 'month' as const,
      boardType: 'kilter',
      layoutIds: [1, 8],
      minQuality: 4,
      setterUsernames: ['jwebb'],
    };
    const sort = { ...DEFAULT_LOGBOOK_SORT, preset: 'easiest' as const };
    store.get.mockResolvedValue({ version: 5, filters, sort });
    expect(await loadLogbookPrefs()).toEqual({ filters, sort });
    expect(store.set).not.toHaveBeenCalled();
  });

  it('writes a from/to only under the Custom window (older bundles have no window)', async () => {
    store.set.mockResolvedValue(undefined);
    const leftover = { fromDate: '2026-01-01', toDate: '2026-02-01' };
    await saveLogbookPrefs({
      filters: { ...DEFAULT_LOGBOOK_FILTERS, ...leftover, dateWindow: 'month' },
      sort: DEFAULT_LOGBOOK_SORT,
    });
    expect(store.set).toHaveBeenLastCalledWith(
      'logbookSearchPrefs',
      expect.objectContaining({
        filters: expect.objectContaining({ dateWindow: 'month', fromDate: '', toDate: '' }),
      }),
    );

    await saveLogbookPrefs({
      filters: { ...DEFAULT_LOGBOOK_FILTERS, ...leftover, dateWindow: 'custom' },
      sort: DEFAULT_LOGBOOK_SORT,
    });
    expect(store.set).toHaveBeenLastCalledWith(
      'logbookSearchPrefs',
      expect.objectContaining({ filters: expect.objectContaining({ dateWindow: 'custom', ...leftover }) }),
    );
  });
});
