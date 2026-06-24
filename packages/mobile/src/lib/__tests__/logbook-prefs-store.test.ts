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
    expect(prefs?.filters.angleRange).toEqual([0, 70]);
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
});
