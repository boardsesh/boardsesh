import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// board-render-presets.ts writes through setBoardRenderSettingsPreference, which
// persists to AsyncStorage — mirrors board-render-settings.test.ts's mock so a
// preset apply can be observed round-tripping through the real store.
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
  loadBoardRenderSettings,
} = await import('../board-render-settings');
const {
  ACCESSIBILITY_OWNED_BOARDSESH_FIELDS,
  BOARD_RENDER_PRESETS,
  applyBoardRenderPreset,
  matchingPresetId,
  mergePresetPreservingAccessibility,
} = await import('../board-render-presets');
const { setBoardseshRenderFieldPreference } = await import('../board-render-settings');

beforeEach(() => {
  storage.clear();
  _resetBoardRenderSettingsForTests();
});

afterEach(() => {
  storage.clear();
  _resetBoardRenderSettingsForTests();
});

describe('BOARD_RENDER_PRESETS', () => {
  it('has one entry per documented preset id', () => {
    expect(BOARD_RENDER_PRESETS.map((preset) => preset.id)).toEqual(['boardsesh', 'bold', 'subtle', 'max-contrast']);
  });

  it('boardsesh preset is the mode switch plus untouched Boardsesh defaults', () => {
    const preset = BOARD_RENDER_PRESETS.find((entry) => entry.id === 'boardsesh')!;
    expect(preset.values).toEqual({ mode: 'boardsesh', boardsesh: DEFAULT_BOARDSESH_RENDER_SETTINGS });
  });

  it('bold preset: plateau falloff, strong veil, 1.3x reach, glow-fill marks', () => {
    const preset = BOARD_RENDER_PRESETS.find((entry) => entry.id === 'bold')!;
    expect(preset.values.mode).toBe('boardsesh');
    expect(preset.values.boardsesh).toEqual({
      ...DEFAULT_BOARDSESH_RENDER_SETTINGS,
      glowFalloff: 'plateau',
      glowReach: 1.3,
      veil: 'strong',
      markStyle: 'glow-fill',
    });
  });

  it('subtle preset: soft falloff, soft veil, 0.8x reach', () => {
    const preset = BOARD_RENDER_PRESETS.find((entry) => entry.id === 'subtle')!;
    expect(preset.values.boardsesh).toEqual({
      ...DEFAULT_BOARDSESH_RENDER_SETTINGS,
      glowFalloff: 'soft',
      glowReach: 0.8,
      veil: 'soft',
    });
  });

  it('max-contrast preset: plateau, custom 0.7 veil, fill marks at 0.85, role glyphs on', () => {
    const preset = BOARD_RENDER_PRESETS.find((entry) => entry.id === 'max-contrast')!;
    expect(preset.values.boardsesh).toEqual({
      ...DEFAULT_BOARDSESH_RENDER_SETTINGS,
      glowFalloff: 'plateau',
      veil: 'custom',
      veilOpacity: 0.7,
      markStyle: 'fill',
      fillOpacity: 0.85,
      roleGlyphs: true,
    });
  });

  it('every preset value is already sanitary — applying one never gets silently altered on write', async () => {
    const { sanitizeBoardRenderSettings } = await import('../board-render-settings');
    for (const preset of BOARD_RENDER_PRESETS) {
      expect(sanitizeBoardRenderSettings(preset.values)).toEqual(preset.values);
    }
  });
});

describe('applyBoardRenderPreset', () => {
  it('writes the preset bundle through the real settings store', async () => {
    await applyBoardRenderPreset('bold');
    const settings = await loadBoardRenderSettings();
    const preset = BOARD_RENDER_PRESETS.find((entry) => entry.id === 'bold')!;
    expect(settings).toEqual(preset.values);
  });

  it('overwrites a prior custom tweak rather than merging with it', async () => {
    const { setBoardseshRenderFieldPreference, setBoardRenderModePreference } =
      await import('../board-render-settings');
    await setBoardRenderModePreference('boardsesh');
    await setBoardseshRenderFieldPreference('glowReach', 1.9);
    await setBoardseshRenderFieldPreference('softDisc', true);

    await applyBoardRenderPreset('subtle');

    const settings = await loadBoardRenderSettings();
    const preset = BOARD_RENDER_PRESETS.find((entry) => entry.id === 'subtle')!;
    expect(settings).toEqual(preset.values);
    expect(settings.boardsesh.softDisc).toBe(false);
  });

  it('is a no-op for an unknown id', async () => {
    await applyBoardRenderPreset('not-a-preset' as never);
    const settings = await loadBoardRenderSettings();
    expect(settings).toEqual(DEFAULT_BOARD_RENDER_SETTINGS);
  });
});

describe('matchingPresetId', () => {
  it('matches the boardsesh preset against the plain defaults with mode set to boardsesh', () => {
    expect(matchingPresetId({ mode: 'boardsesh', boardsesh: DEFAULT_BOARDSESH_RENDER_SETTINGS })).toBe('boardsesh');
  });

  it('is custom for Classic mode — dropping the classic preset means no preset row ever needs to highlight it (the row only shows in Boardsesh)', () => {
    expect(matchingPresetId({ mode: 'classic', boardsesh: DEFAULT_BOARDSESH_RENDER_SETTINGS })).toBe('custom');
  });

  it('does not match "automatic" (mode: default) to any preset even with default fields', () => {
    expect(matchingPresetId(DEFAULT_BOARD_RENDER_SETTINGS)).toBe('custom');
  });

  it('matches every named preset back to itself', () => {
    for (const preset of BOARD_RENDER_PRESETS) {
      expect(matchingPresetId(preset.values)).toBe(preset.id);
    }
  });

  it('is custom once a single field drifts from every preset', () => {
    const preset = BOARD_RENDER_PRESETS.find((entry) => entry.id === 'bold')!;
    const drifted = { ...preset.values, boardsesh: { ...preset.values.boardsesh, glowReach: 1.31 } };
    expect(matchingPresetId(drifted)).toBe('custom');
  });
});

// A monochrome CVD palette turns `roleGlyphs` on (cvd-palette-presets.ts) because
// a colour-only cue is meaningless once every role is a shade of grey. Applying a
// preset writes the whole boardsesh bundle, so without the accessibility merge it
// would take that channel away again — a colour-only board for the one climber who
// cannot use colour.
describe('accessibility-owned fields survive a preset', () => {
  it('names roleGlyphs as the accessibility-owned field', () => {
    expect(ACCESSIBILITY_OWNED_BOARDSESH_FIELDS).toEqual(['roleGlyphs']);
  });

  it.each(BOARD_RENDER_PRESETS.map((preset) => preset.id))('keeps roleGlyphs on through the %s preset', async (id) => {
    await setBoardseshRenderFieldPreference('roleGlyphs', true);

    await applyBoardRenderPreset(id);

    const settings = await loadBoardRenderSettings();
    expect(settings.boardsesh.roleGlyphs).toBe(true);
    // Everything the preset DOES own still lands verbatim.
    const preset = BOARD_RENDER_PRESETS.find((entry) => entry.id === id)!;
    expect(settings.boardsesh.glowFalloff).toBe(preset.values.boardsesh.glowFalloff);
    expect(settings.boardsesh.markStyle).toBe(preset.values.boardsesh.markStyle);
  });

  it('still reports the preset as the match once glyphs are raised above it', async () => {
    await setBoardseshRenderFieldPreference('roleGlyphs', true);
    await applyBoardRenderPreset('subtle');

    // Without the matching relaxation this reads 'custom' from the very next
    // render and no preset chip / carousel card highlights.
    expect(matchingPresetId(await loadBoardRenderSettings())).toBe('subtle');
  });

  it('lets a preset turn glyphs ON — the merge only ever raises the floor', async () => {
    expect((await loadBoardRenderSettings()).boardsesh.roleGlyphs).toBe(false);

    await applyBoardRenderPreset('max-contrast');

    expect((await loadBoardRenderSettings()).boardsesh.roleGlyphs).toBe(true);
  });

  it('merges without mutating either input', () => {
    const preset = BOARD_RENDER_PRESETS.find((entry) => entry.id === 'boardsesh')!;
    const live = {
      ...DEFAULT_BOARD_RENDER_SETTINGS,
      boardsesh: { ...DEFAULT_BOARDSESH_RENDER_SETTINGS, roleGlyphs: true },
    };

    const merged = mergePresetPreservingAccessibility(preset.values, live);

    expect(merged.boardsesh.roleGlyphs).toBe(true);
    expect(preset.values.boardsesh.roleGlyphs).toBe(false);
    expect(live.boardsesh.roleGlyphs).toBe(true);
  });
});
