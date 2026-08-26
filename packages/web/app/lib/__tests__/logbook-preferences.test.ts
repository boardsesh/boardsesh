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

  it('keeps a never-touched pre-v2 "both" payload on the current defaults and stamps v4', () => {
    // The obsolete v1→v2 attempts-drop must NOT chain into v3: legacy users
    // who never diverged land on the current default, not an obsolete one.
    const migrated = sanitizeLogbookPreferences({
      version: 1,
      boardFilter: 'all',
      layoutSelections: ALL_LAYOUT_SELECTIONS,
      filters: {
        ...DEFAULT_LOGBOOK_PREFERENCES.filters,
        includeSends: true,
        includeAttempts: true,
        angleRange: [0, 70],
      },
      sort: DEFAULT_LOGBOOK_PREFERENCES.sort,
    });
    expect(migrated.version).toBe(4);
    expect(migrated.filters.includeSends).toBe(true);
    expect(migrated.filters.includeAttempts).toBe(true);
    expect(migrated.filters.angleRange).toEqual([-5, 70]);
  });

  it('keeps a diverged pre-v2 payload verbatim, attempts included', () => {
    const migrated = sanitizeLogbookPreferences({
      version: 1,
      boardFilter: 'all',
      layoutSelections: ALL_LAYOUT_SELECTIONS,
      filters: {
        ...DEFAULT_LOGBOOK_PREFERENCES.filters,
        includeSends: true,
        includeAttempts: true,
        minGrade: 12,
        angleRange: [0, 50],
      },
      sort: DEFAULT_LOGBOOK_PREFERENCES.sort,
    });
    expect(migrated.filters.includeAttempts).toBe(true);
    expect(migrated.filters.minGrade).toBe(12);
    expect(migrated.filters.angleRange).toEqual([-5, 50]);
  });

  it('refreshes an untouched v2 sends-only payload to attempts-included (v2 to v3)', () => {
    const refreshed = sanitizeLogbookPreferences({
      version: 2,
      boardFilter: 'all',
      layoutSelections: ALL_LAYOUT_SELECTIONS,
      // The v2 resting default: sends only.
      filters: {
        ...DEFAULT_LOGBOOK_PREFERENCES.filters,
        includeSends: true,
        includeAttempts: false,
        angleRange: [0, 70],
      },
      sort: DEFAULT_LOGBOOK_PREFERENCES.sort,
    });
    expect(refreshed.version).toBe(4);
    expect(refreshed.filters.includeAttempts).toBe(true);
  });

  it('migrates partial pre-v3 payloads whose historical angle range was omitted', () => {
    const versionless = sanitizeLogbookPreferences({
      boardFilter: 'all',
      filters: { includeSends: true, includeAttempts: true },
    });
    const versionTwo = sanitizeLogbookPreferences({
      version: 2,
      boardFilter: 'all',
      filters: { includeSends: true, includeAttempts: false },
    });

    expect(versionless.filters.includeAttempts).toBe(true);
    expect(versionTwo.filters.includeAttempts).toBe(true);
    expect(versionless.filters.angleRange).toEqual([-5, 70]);
    expect(versionTwo.filters.angleRange).toEqual([-5, 70]);
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
    expect(kept.version).toBe(4);
    expect(kept.filters.includeAttempts).toBe(false);
    expect(kept.filters.minGrade).toBe(12);
  });

  it('migrates a v3 angle default without changing its status choice', () => {
    const stable = sanitizeLogbookPreferences({
      version: 3,
      boardFilter: 'all',
      layoutSelections: ALL_LAYOUT_SELECTIONS,
      // A v3 install that turned attempts off — respected, not re-defaulted.
      filters: {
        ...DEFAULT_LOGBOOK_PREFERENCES.filters,
        includeSends: true,
        includeAttempts: false,
        angleRange: [0, 70],
      },
      sort: DEFAULT_LOGBOOK_PREFERENCES.sort,
    });
    expect(stable.version).toBe(4);
    expect(stable.filters.includeAttempts).toBe(false);
    expect(stable.filters.angleRange).toEqual([-5, 70]);
  });

  it('preserves an explicit v4 zero lower bound and a pre-v4 positive lower bound', () => {
    const explicitZero = sanitizeLogbookPreferences({
      ...DEFAULT_LOGBOOK_PREFERENCES,
      version: 4,
      filters: { ...DEFAULT_LOGBOOK_PREFERENCES.filters, angleRange: [0, 70] },
    });
    const positiveMinimum = sanitizeLogbookPreferences({
      ...DEFAULT_LOGBOOK_PREFERENCES,
      version: 3,
      filters: { ...DEFAULT_LOGBOOK_PREFERENCES.filters, angleRange: [20, 50] },
    });
    expect(explicitZero.filters.angleRange).toEqual([0, 70]);
    expect(positiveMinimum.filters.angleRange).toEqual([20, 50]);
  });
});
