import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => storage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: async (key: string) => {
      storage.delete(key);
    },
  },
}));

const {
  DEFAULT_BOARD_RENDER_SETTINGS,
  _resetBoardRenderSettingsForTests,
  loadBoardRenderSettings,
  setBoardRenderSettingsPreference,
} = await import('../../board-render-settings');
const { BOARD_RENDER_PRESETS } = await import('../../board-render-presets');
const { matchingBoardLookOptionId } = await import('../board-look-options');
const { loadBoardLookSuggestionDismissals } = await import('../board-look-suggestion-dismissals');
const { applyBoardLookSuggestion, pickBoardLookSuggestion } = await import('../board-look-suggestions');

type Inputs = Parameters<typeof pickBoardLookSuggestion>[0];

/** Settings a suggestion is allowed to act on: the Boardsesh drawing, no glyphs. */
function boardseshSettings(roleGlyphs = false): typeof DEFAULT_BOARD_RENDER_SETTINGS {
  return {
    mode: 'boardsesh',
    boardsesh: { ...DEFAULT_BOARD_RENDER_SETTINGS.boardsesh, roleGlyphs },
  };
}

/** Every gate open, greyscale on — each case below spoils exactly one thing. */
function eligible(overrides: Partial<Inputs> = {}): Inputs {
  return {
    signals: { increaseContrast: 'off', grayscale: 'on', ready: true },
    settings: boardseshSettings(),
    boardseshRendererAvailable: true,
    dismissed: { increaseContrast: false, grayscale: false },
    dismissalsLoaded: true,
    platform: 'ios',
    ...overrides,
  };
}

beforeEach(() => {
  storage.clear();
  _resetBoardRenderSettingsForTests();
});

afterEach(() => {
  storage.clear();
  _resetBoardRenderSettingsForTests();
});

describe('pickBoardLookSuggestion', () => {
  it('suggests role glyphs to a climber whose phone is in greyscale', () => {
    expect(pickBoardLookSuggestion(eligible())?.id).toBe('grayscale');
  });

  it('suggests Max contrast when the OS contrast setting is on', () => {
    const suggestion = pickBoardLookSuggestion(
      eligible({ signals: { increaseContrast: 'on', grayscale: 'off', ready: true } }),
    );
    expect(suggestion?.id).toBe('increaseContrast');
  });

  describe('every gate suppresses on its own', () => {
    it('says nothing until the signals have settled', () => {
      expect(
        pickBoardLookSuggestion(eligible({ signals: { increaseContrast: 'off', grayscale: 'on', ready: false } })),
      ).toBeNull();
    });

    it('says nothing while a signal is unknown', () => {
      // A rejected or unqueryable signal is not permission to interrupt.
      expect(
        pickBoardLookSuggestion(
          eligible({ signals: { increaseContrast: 'unknown', grayscale: 'unknown', ready: true } }),
        ),
      ).toBeNull();
    });

    it('says nothing when the signal is simply off', () => {
      expect(
        pickBoardLookSuggestion(eligible({ signals: { increaseContrast: 'off', grayscale: 'off', ready: true } })),
      ).toBeNull();
    });

    it('says nothing until the dismissals have loaded', () => {
      expect(pickBoardLookSuggestion(eligible({ dismissalsLoaded: false }))).toBeNull();
    });

    it('says nothing once the climber has turned it down', () => {
      expect(pickBoardLookSuggestion(eligible({ dismissed: { increaseContrast: false, grayscale: true } }))).toBeNull();
    });

    it('says nothing while the renderer probe has not answered', () => {
      // `null` is "not probed yet", which is not a yes.
      expect(pickBoardLookSuggestion(eligible({ boardseshRendererAvailable: null }))).toBeNull();
    });

    it('says nothing when the installed renderer cannot draw the Boardsesh look', () => {
      expect(pickBoardLookSuggestion(eligible({ boardseshRendererAvailable: false }))).toBeNull();
    });

    it('never offers to flip a climber who explicitly chose Classic', () => {
      expect(pickBoardLookSuggestion(eligible({ settings: { ...boardseshSettings(), mode: 'classic' } }))).toBeNull();
    });

    it('still speaks to a climber on the app default, which IS the Boardsesh drawing', () => {
      expect(pickBoardLookSuggestion(eligible({ settings: { ...boardseshSettings(), mode: 'default' } }))?.id).toBe(
        'grayscale',
      );
    });

    it('says nothing when role glyphs are already on', () => {
      expect(pickBoardLookSuggestion(eligible({ settings: boardseshSettings(true) }))).toBeNull();
    });

    it('says nothing when the climber is already on Max contrast', () => {
      const maxContrast = BOARD_RENDER_PRESETS.find((preset) => preset.id === 'max-contrast');
      if (!maxContrast) throw new Error('missing max-contrast preset');
      const settings = maxContrast.values;
      expect(matchingBoardLookOptionId(settings)).toBe('max-contrast');
      expect(
        pickBoardLookSuggestion(
          eligible({ settings, signals: { increaseContrast: 'on', grayscale: 'off', ready: true } }),
        ),
      ).toBeNull();
    });
  });

  it('prefers greyscale over contrast when both are on', () => {
    // Rarer, more certain (a real query on both platforms), and role glyphs are
    // a contrast affordance in their own right.
    const suggestion = pickBoardLookSuggestion(
      eligible({ signals: { increaseContrast: 'on', grayscale: 'on', ready: true } }),
    );
    expect(suggestion?.id).toBe('grayscale');
  });

  it('falls through to contrast when greyscale has been dismissed', () => {
    const suggestion = pickBoardLookSuggestion(
      eligible({
        signals: { increaseContrast: 'on', grayscale: 'on', ready: true },
        dismissed: { increaseContrast: false, grayscale: true },
      }),
    );
    expect(suggestion?.id).toBe('increaseContrast');
  });

  it('names the OS setting the way the running platform names it', () => {
    // Naming it exactly is what makes the banner credible rather than creepy.
    const contrastOn = { increaseContrast: 'on', grayscale: 'off', ready: true } as const;
    expect(pickBoardLookSuggestion(eligible({ signals: contrastOn, platform: 'ios' }))?.titleI18nKey).toBe(
      'mobile.more.boardLook.suggestion.increaseContrast.titleIos',
    );
    expect(pickBoardLookSuggestion(eligible({ signals: contrastOn, platform: 'android' }))?.titleI18nKey).toBe(
      'mobile.more.boardLook.suggestion.increaseContrast.titleAndroid',
    );
    expect(pickBoardLookSuggestion(eligible({ signals: contrastOn, platform: 'web' }))).toBeNull();
  });

  it('returns only i18n keys — the banner has no colours to hand anyone', () => {
    const suggestion = pickBoardLookSuggestion(eligible());
    expect(Object.keys(suggestion ?? {}).sort()).toEqual(['applyI18nKey', 'bodyI18nKey', 'id', 'titleI18nKey']);
  });
});

describe('applyBoardLookSuggestion never touches the hold colours', () => {
  // THE invariant. Applying a colour-vision palette writes the four role colours
  // through the same store a manual colour pick writes, so it reaches the
  // PHYSICAL board's LEDs. A greyscale phone display says nothing about the LEDs
  // on the wall, so no suggestion may ever write there.
  it('turns role glyphs on for greyscale and leaves the hold-colour store alone', async () => {
    storage.set('holdColorOverrides', JSON.stringify({ colors: { HAND: '#123456' } }));

    await applyBoardLookSuggestion('grayscale');

    expect((await loadBoardRenderSettings()).boardsesh.roleGlyphs).toBe(true);
    expect(storage.get('holdColorOverrides')).toContain('#123456');
  });

  it('applies the Max contrast preset and leaves the hold-colour store alone', async () => {
    storage.set('holdColorOverrides', JSON.stringify({ colors: { HAND: '#123456' } }));

    await applyBoardLookSuggestion('increaseContrast');

    expect(matchingBoardLookOptionId(await loadBoardRenderSettings())).toBe('max-contrast');
    expect(storage.get('holdColorOverrides')).toContain('#123456');
  });

  it('writes nothing but the render settings and its own dismissal marker', async () => {
    await applyBoardLookSuggestion('grayscale');
    await applyBoardLookSuggestion('increaseContrast');

    expect([...storage.keys()].sort()).toEqual(['boardLookSuggestionDismissals', 'boardRenderSettings']);
  });

  it('records the dismissal, so an applied suggestion can never come back', async () => {
    await setBoardRenderSettingsPreference(boardseshSettings());

    await applyBoardLookSuggestion('grayscale');

    const dismissed = await loadBoardLookSuggestionDismissals();
    expect(dismissed.grayscale).toBe(true);
    expect(pickBoardLookSuggestion(eligible({ dismissed, settings: await loadBoardRenderSettings() }))).toBeNull();
  });
});
