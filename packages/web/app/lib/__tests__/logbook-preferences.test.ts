import { describe, expect, it } from 'vite-plus/test';
import { ALL_LAYOUT_SELECTIONS, DEFAULT_LOGBOOK_PREFERENCES, sanitizeLogbookPreferences } from '../logbook-preferences';

describe('sanitizeLogbookPreferences', () => {
  it('returns defaults for non-object values', () => {
    expect(sanitizeLogbookPreferences(null)).toEqual(DEFAULT_LOGBOOK_PREFERENCES);
  });

  it('drops invalid board filters and layout ids', () => {
    const result = sanitizeLogbookPreferences({
      version: 1,
      boardFilter: 'spraywall',
      layoutSelections: {
        kilter: [999999],
        tension: [ALL_LAYOUT_SELECTIONS.tension[0]],
        moonboard: [],
      },
      filters: {},
      sort: {},
    });

    expect(result.boardFilter).toBe('all');
    expect(result.layoutSelections.kilter).toEqual(ALL_LAYOUT_SELECTIONS.kilter);
    expect(result.layoutSelections.tension).toEqual([ALL_LAYOUT_SELECTIONS.tension[0]]);
    expect(result.layoutSelections.moonboard).toEqual(ALL_LAYOUT_SELECTIONS.moonboard);
  });

  it('forces at least one result type and clears flashOnly when sends are off', () => {
    const result = sanitizeLogbookPreferences({
      version: 1,
      boardFilter: 'all',
      layoutSelections: ALL_LAYOUT_SELECTIONS,
      filters: {
        includeSends: false,
        includeAttempts: false,
        flashOnly: true,
        minGrade: '',
        maxGrade: '',
        fromDate: '',
        toDate: '',
        angleRange: [0, 70],
        benchmarkOnly: false,
      },
      sort: DEFAULT_LOGBOOK_PREFERENCES.sort,
    });

    expect(result.filters.includeSends).toBe(true);
    expect(result.filters.includeAttempts).toBe(false);
    expect(result.filters.flashOnly).toBe(true);
  });

  it('drops attempts from a pre-v2 "both" payload (v1 to v2 step) and stamps v3', () => {
    const migrated = sanitizeLogbookPreferences({
      version: 1,
      boardFilter: 'all',
      layoutSelections: ALL_LAYOUT_SELECTIONS,
      filters: { ...DEFAULT_LOGBOOK_PREFERENCES.filters, includeSends: true, includeAttempts: true },
      sort: DEFAULT_LOGBOOK_PREFERENCES.sort,
    });
    // The v1→v2 step ran (attempts dropped) and the payload is stamped to the
    // current version.
    expect(migrated.version).toBe(3);
    expect(migrated.filters.includeSends).toBe(true);
    expect(migrated.filters.includeAttempts).toBe(false);
  });

  it('refreshes an untouched v2 sends-only payload to attempts-included (v2 to v3)', () => {
    const refreshed = sanitizeLogbookPreferences({
      version: 2,
      boardFilter: 'all',
      layoutSelections: ALL_LAYOUT_SELECTIONS,
      // The v2 resting default: sends only.
      filters: { ...DEFAULT_LOGBOOK_PREFERENCES.filters, includeSends: true, includeAttempts: false },
      sort: DEFAULT_LOGBOOK_PREFERENCES.sort,
    });
    expect(refreshed.version).toBe(3);
    expect(refreshed.filters.includeAttempts).toBe(true);
  });

  it('keeps an explicit v2 "sends only" choice when the user diverged elsewhere', () => {
    const kept = sanitizeLogbookPreferences({
      version: 2,
      boardFilter: 'all',
      layoutSelections: ALL_LAYOUT_SELECTIONS,
      // sends-only AND a grade floor — a real, diverged choice.
      filters: { ...DEFAULT_LOGBOOK_PREFERENCES.filters, includeSends: true, includeAttempts: false, minGrade: 12 },
      sort: DEFAULT_LOGBOOK_PREFERENCES.sort,
    });
    expect(kept.version).toBe(3);
    expect(kept.filters.includeAttempts).toBe(false);
    expect(kept.filters.minGrade).toBe(12);
  });

  it('leaves an already-v3 payload untouched', () => {
    const stable = sanitizeLogbookPreferences({
      version: 3,
      boardFilter: 'all',
      layoutSelections: ALL_LAYOUT_SELECTIONS,
      // A v3 install that turned attempts off — respected, not re-defaulted.
      filters: { ...DEFAULT_LOGBOOK_PREFERENCES.filters, includeSends: true, includeAttempts: false },
      sort: DEFAULT_LOGBOOK_PREFERENCES.sort,
    });
    expect(stable.version).toBe(3);
    expect(stable.filters.includeAttempts).toBe(false);
  });
});
