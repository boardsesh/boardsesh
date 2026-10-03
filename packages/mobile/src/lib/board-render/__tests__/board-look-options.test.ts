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
  DEFAULT_SPRAY_WALL_LOOK_OPTION_ID,
  SPRAY_WALL_DIM_RANGE,
  SPRAY_WALL_LOOK_OPTIONS,
  applyBoardLookOption,
  boardLookOptionWallDefault,
  sprayWallDimLevel,
  withSprayWallDim,
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
  it('offers the onboarding step the product order, with the two circle looks adjacent', () => {
    // Modern Classic sits immediately before Classic: a climber who came for
    // the circles they already know meets the veiled version of them first, and
    // the pair can be compared with one swipe. Aura Outline leads that
    // stroke-forward group rather than sitting with the soft Aura variants.
    expect(BOARD_LOOK_ONBOARDING_OPTIONS.map((option) => option.id)).toEqual([
      'aura',
      'aura-subtle',
      'aura-outline',
      'modern-classic',
      'classic',
      'max-contrast',
      'custom',
    ]);
  });

  it('offers the settings screen Aura Bold as well, in the same order as the step', () => {
    expect(BOARD_LOOK_SETTINGS_OPTIONS.map((option) => option.id)).toEqual([
      'aura',
      'aura-subtle',
      'aura-bold',
      'aura-outline',
      'modern-classic',
      'classic',
      'max-contrast',
      'custom',
    ]);
  });

  it('names Aura Outline as the spray-wall default, and it is a real card in both rails', () => {
    // The spray-wall creation step reads this as its default selection: an id
    // that is not offered would open that step with nothing selected.
    expect(DEFAULT_SPRAY_WALL_LOOK_OPTION_ID).toBe('aura-outline');
    for (const options of [BOARD_LOOK_ONBOARDING_OPTIONS, BOARD_LOOK_SETTINGS_OPTIONS]) {
      const option = options.find((entry) => entry.id === DEFAULT_SPRAY_WALL_LOOK_OPTION_ID);
      expect(option).toBeDefined();
      expect(option?.previewSettings?.boardsesh.markStyle).toBe('outline');
      expect(option?.requiresBoardseshRenderer).toBe(true);
    }
  });

  it('gives Aura Outline its own label and description keys', () => {
    const outline = BOARD_LOOK_SETTINGS_OPTIONS.find((option) => option.id === 'aura-outline')!;
    expect(outline.labelI18nKey).toBe('mobile.settings.boardLook.presets.auraOutline');
    expect(outline.descriptionI18nKey).toBe('mobile.settings.boardLook.presets.descriptions.auraOutline');
  });

  it('previews Custom as the Aura Bold bundle under a question mark in onboarding', () => {
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

  it('marks only Classic as drawable without the Boardsesh renderer', () => {
    const independent = BOARD_LOOK_ONBOARDING_OPTIONS.filter((option) => !option.requiresBoardseshRenderer);
    expect(independent.map((option) => option.id)).toEqual(['classic']);
  });
});

describe('the spray-wall look step', () => {
  it('offers the onboarding looks without Custom, with the wall default among them', () => {
    expect(SPRAY_WALL_LOOK_OPTIONS.map((option) => option.id)).toEqual([
      'aura',
      'aura-subtle',
      'aura-outline',
      'modern-classic',
      'classic',
      'max-contrast',
    ]);
    expect(SPRAY_WALL_LOOK_OPTIONS.some((option) => option.id === DEFAULT_SPRAY_WALL_LOOK_OPTION_ID)).toBe(true);
  });

  it('stores every card as a concrete mode and the card’s own bundle', () => {
    for (const option of SPRAY_WALL_LOOK_OPTIONS) {
      const stored = boardLookOptionWallDefault(option.id);
      expect(stored).not.toBeNull();
      expect(['classic', 'aura']).toContain(stored?.mode);
      expect(stored?.boardsesh).toEqual(option.previewSettings?.boardsesh);
    }
    expect(boardLookOptionWallDefault('classic')?.mode).toBe('classic');
    expect(boardLookOptionWallDefault(DEFAULT_SPRAY_WALL_LOOK_OPTION_ID)).toEqual({
      mode: 'aura',
      boardsesh: expect.objectContaining({ markStyle: 'outline', holdShape: 'silhouette' }),
    });
  });

  it('has nothing to store for Custom', () => {
    expect(boardLookOptionWallDefault('custom')).toBeNull();
    expect(boardLookOptionWallDefault('custom', BOARD_LOOK_SETTINGS_OPTIONS)).toBeNull();
  });

  it('does not bake the creator’s own role glyphs into the wall look', async () => {
    // Viewers get THEIR accessibility floor raised onto a wall look when it is
    // resolved; the stored bundle stays the card's own.
    await setBoardseshRenderFieldPreference('roleGlyphs', true);
    expect(boardLookOptionWallDefault(DEFAULT_SPRAY_WALL_LOOK_OPTION_ID)?.boardsesh.roleGlyphs).toBe(false);
  });
});

describe('CLASSIC_PREVIEW_SETTINGS', () => {
  it('signs as an ordinary classic render, so the card shares the app’s PNG', () => {
    const effective = resolveEffectiveRenderSettings(CLASSIC_PREVIEW_SETTINGS, true);
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
      // A climber with role glyphs on must see them in the PREVIEW too, or the
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
  it('reads a never-chosen climber as the plain Aura card', () => {
    // `mode: 'default'` is the entire audience of the onboarding step. Matching
    // it as 'custom' would open the carousel with nothing selected.
    expect(matchingBoardLookOptionId(DEFAULT_BOARD_RENDER_SETTINGS)).toBe('aura');
  });

  it('reads an explicit classic choice as Classic, not as a preset', () => {
    expect(matchingBoardLookOptionId({ ...DEFAULT_BOARD_RENDER_SETTINGS, mode: 'classic' })).toBe('classic');
  });

  it('tells Modern Classic apart from Aura on the hold shape alone', () => {
    // The two bundles differ in exactly one field. If `holdShape` ever stopped
    // being part of the comparison, picking Modern Classic would highlight the
    // Aura card and the climber's own choice would read back as somebody else's.
    expect(
      matchingBoardLookOptionId({
        mode: 'aura',
        boardsesh: { ...DEFAULT_BOARDSESH_RENDER_SETTINGS, holdShape: 'circle' },
      }),
    ).toBe('modern-classic');
    expect(matchingBoardLookOptionId({ ...DEFAULT_BOARD_RENDER_SETTINGS, mode: 'aura' })).toBe('aura');
  });

  it('reads a hand-tuned bundle as Custom', () => {
    expect(
      matchingBoardLookOptionId({
        mode: 'aura',
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
    expect(settings.mode).toBe('aura');
    expect(settings.boardsesh.glowReach).toBe(DEFAULT_BOARDSESH_RENDER_SETTINGS.glowReach);
  });

  it('applies a preset card verbatim', async () => {
    await applyBoardLookOption('aura-subtle');

    const settings = await loadBoardRenderSettings();
    expect(settings.mode).toBe('aura');
    expect(settings.boardsesh.glowReach).toBe(0.8);
    expect(matchingBoardLookOptionId(settings)).toBe('aura-subtle');
  });

  it('applies Aura Outline and reads it back as the Outline card', async () => {
    await applyBoardLookOption('aura-outline');

    const settings = await loadBoardRenderSettings();
    expect(settings.mode).toBe('aura');
    expect(settings.boardsesh.markStyle).toBe('outline');
    expect(settings.boardsesh.holdShape).toBe('silhouette');
    expect(matchingBoardLookOptionId(settings)).toBe('aura-outline');
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
      return buildBoardRenderSignature(resolveEffectiveRenderSettings(bundle, true), DARK_FIELD, 0.6);
    });

    expect(new Set(signatures).size).toBe(signatures.length);
  });

  it('gives a preview card the same signature as actually applying it', async () => {
    const previews = buildBoardLookPreviewSettings(BOARD_LOOK_SETTINGS_OPTIONS, DEFAULT_BOARD_RENDER_SETTINGS);
    const previewed = buildBoardRenderSignature(
      resolveEffectiveRenderSettings(previews.get('aura-subtle')!, true),
      DARK_FIELD,
      0.6,
    );

    await applyBoardLookOption('aura-subtle');
    const applied = buildBoardRenderSignature(
      resolveEffectiveRenderSettings(await loadBoardRenderSettings(), true),
      DARK_FIELD,
      0.6,
    );

    // The card is a promise: what it drew is what the climber now has.
    expect(applied).toBe(previewed);
  });
});

describe('the spray look step dimming slider', () => {
  const option = (id: string) => {
    const found = SPRAY_WALL_LOOK_OPTIONS.find((candidate) => candidate.id === id);
    if (!found) throw new Error(`no spray look option ${id}`);
    return found;
  };

  it("starts at each look's own dimming, and has none for Classic", () => {
    // `auto` has no measured brightness to size itself from on a photo, so it is 0.
    expect(sprayWallDimLevel(option('aura-outline'))).toBe(0);
    expect(sprayWallDimLevel(option('aura-subtle'))).toBe(0.3);
    expect(sprayWallDimLevel(option('max-contrast'))).toBe(0.7);
    expect(sprayWallDimLevel(option('classic'))).toBeNull();
  });

  it('leaves every card alone until the creator touches the slider', () => {
    expect(withSprayWallDim(SPRAY_WALL_LOOK_OPTIONS, null)).toBe(SPRAY_WALL_LOOK_OPTIONS);
  });

  it('applies a touched value to every look with a veil, and to what the wall stores', () => {
    const dimmed = withSprayWallDim(SPRAY_WALL_LOOK_OPTIONS, 0.45);
    for (const candidate of dimmed) {
      if (candidate.id === 'classic') continue;
      expect(sprayWallDimLevel(candidate)).toBe(0.45);
    }
    const stored = boardLookOptionWallDefault('aura-outline', dimmed);
    expect(stored?.boardsesh.veil).toBe('custom');
    expect(stored?.boardsesh.veilOpacity).toBe(0.45);
    // The rest of the look is untouched.
    expect(stored?.boardsesh.markStyle).toBe('outline');
    // Classic has no veil, so it is handed back as it was.
    expect(dimmed.find((candidate) => candidate.id === 'classic')).toBe(option('classic'));
  });

  it('stores an explicit off at zero, even over a look with its own strong veil', () => {
    const stored = boardLookOptionWallDefault('max-contrast', withSprayWallDim(SPRAY_WALL_LOOK_OPTIONS, 0));
    expect(stored?.boardsesh.veil).toBe('off');
  });

  it('stays inside the bounds the backend validates against', () => {
    expect(SPRAY_WALL_DIM_RANGE.min).toBe(0);
    const stored = boardLookOptionWallDefault(
      'aura-outline',
      withSprayWallDim(SPRAY_WALL_LOOK_OPTIONS, SPRAY_WALL_DIM_RANGE.max),
    );
    expect(stored?.boardsesh.veilOpacity).toBeLessThanOrEqual(SPRAY_WALL_DIM_RANGE.max);
  });
});
