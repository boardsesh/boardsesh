import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The option module writes through setBoardRenderSettingsPreference /
// setBoardRenderModePreference, which persist to AsyncStorage — same mock shape
// as board-render-presets.test.ts so an apply can be observed round-tripping.
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
  DEFAULT_BOARDSESH_RENDER_SETTINGS,
  DEFAULT_BOARD_RENDER_SETTINGS,
  _resetBoardRenderSettingsForTests,
  buildBoardRenderSignature,
  loadBoardRenderSettings,
  resolveEffectiveRenderSettings,
  setBoardseshRenderFieldPreference,
} = await import('../../board-render-settings');
const {
  BOARD_LOOK_ONBOARDING_OPTIONS,
  BOARD_LOOK_SETTINGS_OPTIONS,
  CLASSIC_PREVIEW_SETTINGS,
  applyBoardLookOption,
  buildBoardLookPreviewSettings,
  matchingBoardLookOptionId,
} = await import('../board-look-options');

beforeEach(() => {
  storage.clear();
  _resetBoardRenderSettingsForTests();
});

afterEach(() => {
  storage.clear();
  _resetBoardRenderSettingsForTests();
});

describe('the option lists', () => {
  it('offers the onboarding step the product order, Custom last', () => {
    expect(BOARD_LOOK_ONBOARDING_OPTIONS.map((option) => option.id)).toEqual([
      'boardsesh',
      'subtle',
      'max-contrast',
      'classic',
      'custom',
    ]);
  });

  it('offers the settings screen `bold` as well', () => {
    expect(BOARD_LOOK_SETTINGS_OPTIONS.map((option) => option.id)).toEqual([
      'boardsesh',
      'subtle',
      'max-contrast',
      'bold',
      'classic',
      'custom',
    ]);
  });

  it('previews Custom as the bold bundle under a question mark in onboarding', () => {
    const custom = BOARD_LOOK_ONBOARDING_OPTIONS.find((option) => option.id === 'custom')!;
    expect(custom.placeholderOverlay).toBe(true);
    expect(custom.previewSettings?.boardsesh.glowReach).toBe(1.3);
  });

  it('previews Custom as the climber’s own live settings in the settings screen', () => {
    const custom = BOARD_LOOK_SETTINGS_OPTIONS.find((option) => option.id === 'custom')!;
    expect(custom.placeholderOverlay).toBe(false);
    // null = "read the store", which is what an absent renderSettingsOverride does.
    expect(custom.previewSettings).toBeNull();
  });

  it('makes the settings Custom card a report, not a button', () => {
    // Regression guard. The chip row this carousel replaced rendered Custom as a
    // plain View precisely because it means "your settings match no preset" —
    // applying it would overwrite the hand-tuning it is reporting.
    const custom = BOARD_LOOK_SETTINGS_OPTIONS.find((option) => option.id === 'custom')!;
    expect(custom.selectable).toBe(false);
  });

  it('keeps the onboarding Custom card selectable — there it means "let me build one"', () => {
    const custom = BOARD_LOOK_ONBOARDING_OPTIONS.find((option) => option.id === 'custom')!;
    expect(custom.selectable).toBe(true);
  });

  it('leaves every other card on both surfaces selectable', () => {
    const notSelectable = [...BOARD_LOOK_ONBOARDING_OPTIONS, ...BOARD_LOOK_SETTINGS_OPTIONS]
      .filter((option) => !option.selectable)
      .map((option) => option.id);
    expect(notSelectable).toEqual(['custom']);
  });

  it('marks only Classic as drawable without the Boardsesh renderer', () => {
    const independent = BOARD_LOOK_ONBOARDING_OPTIONS.filter((option) => !option.requiresBoardseshRenderer);
    expect(independent.map((option) => option.id)).toEqual(['classic']);
  });
});

describe('CLASSIC_PREVIEW_SETTINGS', () => {
  it('signs as an ordinary classic render, so the card shares the app’s PNG', () => {
    const effective = resolveEffectiveRenderSettings(CLASSIC_PREVIEW_SETTINGS, undefined, true);
    expect(effective.mode).toBe('classic');
    // An empty board-render signature is what every classic surface already
    // produces; a non-empty one here would mint a second PNG for identical pixels.
    expect(buildBoardRenderSignature(effective, '#181225', 0.6)).toBe('');
  });
});

describe('buildBoardLookPreviewSettings', () => {
  it('raises an accessibility-owned field into every card', () => {
    const live = {
      ...DEFAULT_BOARD_RENDER_SETTINGS,
      boardsesh: { ...DEFAULT_BOARDSESH_RENDER_SETTINGS, roleGlyphs: true },
    };

    const previews = buildBoardLookPreviewSettings(BOARD_LOOK_ONBOARDING_OPTIONS, live);

    for (const option of BOARD_LOOK_ONBOARDING_OPTIONS) {
      if (!option.previewSettings) continue;
      // A monochrome climber must see their glyphs in the PREVIEW too, or the
      // card is not showing them what saving it would produce.
      expect(previews.get(option.id)?.boardsesh.roleGlyphs).toBe(true);
    }
  });

  it('leaves a live-preview card with no override, so it reads the store', () => {
    const previews = buildBoardLookPreviewSettings(BOARD_LOOK_SETTINGS_OPTIONS, DEFAULT_BOARD_RENDER_SETTINGS);
    expect(previews.get('custom')).toBeUndefined();
  });

  it('keeps the Classic card on the classic drawing', () => {
    const previews = buildBoardLookPreviewSettings(BOARD_LOOK_ONBOARDING_OPTIONS, DEFAULT_BOARD_RENDER_SETTINGS);
    expect(previews.get('classic')?.mode).toBe('classic');
  });
});

describe('matchingBoardLookOptionId', () => {
  it('reads a never-chosen climber as the plain Boardsesh card', () => {
    // `mode: 'default'` is the entire audience of the onboarding step. Matching
    // it as 'custom' would open the carousel with nothing selected.
    expect(matchingBoardLookOptionId(DEFAULT_BOARD_RENDER_SETTINGS)).toBe('boardsesh');
  });

  it('reads an explicit classic choice as Classic, not as a preset', () => {
    expect(matchingBoardLookOptionId({ ...DEFAULT_BOARD_RENDER_SETTINGS, mode: 'classic' })).toBe('classic');
  });

  it('reads a hand-tuned bundle as Custom', () => {
    expect(
      matchingBoardLookOptionId({
        mode: 'boardsesh',
        boardsesh: { ...DEFAULT_BOARDSESH_RENDER_SETTINGS, glowReach: 1.77 },
      }),
    ).toBe('custom');
  });
});

describe('applyBoardLookOption', () => {
  it('writes only the mode for Classic, keeping every Boardsesh knob', async () => {
    await setBoardseshRenderFieldPreference('glowReach', 1.4);

    await applyBoardLookOption('classic');

    const settings = await loadBoardRenderSettings();
    expect(settings.mode).toBe('classic');
    // Switching to the classic drawing and back must not discard tuning.
    expect(settings.boardsesh.glowReach).toBe(1.4);
  });

  it('lands Custom on the plain Boardsesh bundle, ready to tune', async () => {
    await applyBoardLookOption('custom');

    const settings = await loadBoardRenderSettings();
    expect(settings.mode).toBe('boardsesh');
    expect(settings.boardsesh.glowReach).toBe(DEFAULT_BOARDSESH_RENDER_SETTINGS.glowReach);
  });

  it('applies a preset card verbatim', async () => {
    await applyBoardLookOption('subtle');

    const settings = await loadBoardRenderSettings();
    expect(settings.mode).toBe('boardsesh');
    expect(settings.boardsesh.glowReach).toBe(0.8);
    expect(matchingBoardLookOptionId(settings)).toBe('subtle');
  });
});

// The whole reason a preview card can render a preset the climber is not on:
// the render signature — and therefore the PNG cache key — varies with the
// settings a render was ASKED for. If two option bundles signed the same, one
// card would silently serve the other's picture.
describe('every option signs differently, so no two cards share a PNG', () => {
  const DARK_FIELD = '#181225';

  it('produces a distinct signature per card', () => {
    const previews = buildBoardLookPreviewSettings(BOARD_LOOK_SETTINGS_OPTIONS, DEFAULT_BOARD_RENDER_SETTINGS);

    const signatures = BOARD_LOOK_SETTINGS_OPTIONS.filter((option) => option.previewSettings).map((option) => {
      const bundle = previews.get(option.id)!;
      return buildBoardRenderSignature(resolveEffectiveRenderSettings(bundle, undefined, true), DARK_FIELD, 0.6);
    });

    expect(new Set(signatures).size).toBe(signatures.length);
  });

  it('gives a preview card the same signature as actually applying it', async () => {
    const previews = buildBoardLookPreviewSettings(BOARD_LOOK_SETTINGS_OPTIONS, DEFAULT_BOARD_RENDER_SETTINGS);
    const previewed = buildBoardRenderSignature(
      resolveEffectiveRenderSettings(previews.get('subtle')!, undefined, true),
      DARK_FIELD,
      0.6,
    );

    await applyBoardLookOption('subtle');
    const applied = buildBoardRenderSignature(
      resolveEffectiveRenderSettings(await loadBoardRenderSettings(), undefined, true),
      DARK_FIELD,
      0.6,
    );

    // The card is a promise: what it drew is what the climber now has.
    expect(applied).toBe(previewed);
  });
});
