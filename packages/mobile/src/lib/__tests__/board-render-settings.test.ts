import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VEIL_TUNING } from '@boardsesh/board-art-geometry';

// The store hydrates from AsyncStorage once per JS lifetime, so every case that
// cares about persistence drives it through a controllable mock rather than the
// shared in-memory stub.
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
  BOARD_FIELD_COLORS,
  BOARD_RENDER_SETTING_BOUNDS,
  DEFAULT_BOARDSESH_RENDER_SETTINGS,
  DEFAULT_BOARD_RENDER_SETTINGS,
  VEIL_SETTING_OPACITY,
  EDITING_MAX_VEIL_OPACITY,
  _resetBoardRenderSettingsForTests,
  boardFieldColorForScheme,
  buildBoardRenderSignature,
  loadBoardRenderSettings,
  requestedBoardRenderMode,
  resolveEffectiveRenderSettings,
  resolveVeilOpacity,
  sanitizeBoardRenderSettings,
  setBoardRenderModePreference,
  setBoardRenderSettingsPreference,
  setBoardseshRenderFieldPreference,
  resetBoardRenderSettings,
} = await import('../board-render-settings');

type BoardseshRenderSettings = typeof DEFAULT_BOARDSESH_RENDER_SETTINGS;
type BoardRenderSettings = typeof DEFAULT_BOARD_RENDER_SETTINGS;

const STORAGE_KEY = 'boardRenderSettings';
const DARK_FIELD = BOARD_FIELD_COLORS.dark;

function settingsWith(boardsesh: Partial<BoardseshRenderSettings>, mode: BoardRenderSettings['mode'] = 'aura') {
  return { mode, boardsesh: { ...DEFAULT_BOARDSESH_RENDER_SETTINGS, ...boardsesh } };
}

// Sanitised on the way in, like every real caller: the hook reads its settings
// out of the store, which clamps and rounds before anything sees them.
function boardseshSignature(boardsesh: Partial<BoardseshRenderSettings>, veilOpacity = 0.6): string {
  return buildBoardRenderSignature(
    resolveEffectiveRenderSettings(sanitizeBoardRenderSettings(settingsWith(boardsesh)), true),
    DARK_FIELD,
    veilOpacity,
  );
}

beforeEach(() => {
  storage.clear();
  _resetBoardRenderSettingsForTests();
});

describe('defaults', () => {
  it('ships the classic drawing, the soft glow, and the measured veil', () => {
    expect(DEFAULT_BOARD_RENDER_SETTINGS.mode).toBe('default');
    expect(DEFAULT_BOARDSESH_RENDER_SETTINGS).toEqual({
      glowFalloff: 'default',
      glowReach: 1,
      plateauShare: 0.4,
      veil: 'auto',
      veilOpacity: 0.6,
      markStyle: 'glow',
      fillOpacity: 0.55,
      softDisc: false,
      smallHoldBoost: true,
      ledDots: true,
      roleGlyphs: false,
      thumbnailStyle: 'fill',
      holdShape: 'silhouette',
    });
  });

  it('offers the same two washes `auto` would have measured', () => {
    // A climber overriding the measurement picks one of the buckets, not a
    // third strength the veil tuning has never been calibrated for.
    expect(VEIL_SETTING_OPACITY.soft).toBe(VEIL_TUNING.veilSoftOpacity);
    expect(VEIL_SETTING_OPACITY.strong).toBe(VEIL_TUNING.veilStrongOpacity);
  });

  it('paints the veil toward the theme’s own play field', () => {
    // #181225 is androidFallbackColors.dark.secondaryBackground in
    // packages/mobile/src/theme/colors.ts, restated as a hex the veil can
    // subtract a lightness from (the theme resolves to a PlatformColor on iOS).
    expect(boardFieldColorForScheme('dark')).toBe('#181225');
    expect(boardFieldColorForScheme('light')).toBe('#FFFFFF');
  });
});

describe('sanitizeBoardRenderSettings', () => {
  it('clamps every slider into its published range', () => {
    const sanitized = sanitizeBoardRenderSettings({
      mode: 'aura',
      boardsesh: { glowReach: 99, plateauShare: -3, veilOpacity: 5, fillOpacity: 0 },
    });

    expect(sanitized.boardsesh.glowReach).toBe(BOARD_RENDER_SETTING_BOUNDS.glowReach.max);
    expect(sanitized.boardsesh.plateauShare).toBe(BOARD_RENDER_SETTING_BOUNDS.plateauShare.min);
    expect(sanitized.boardsesh.veilOpacity).toBe(BOARD_RENDER_SETTING_BOUNDS.veilOpacity.max);
    expect(sanitized.boardsesh.fillOpacity).toBe(BOARD_RENDER_SETTING_BOUNDS.fillOpacity.min);
  });

  it('rounds a slider’s float noise away so it cannot mint a second cache key', () => {
    const sanitized = sanitizeBoardRenderSettings({ boardsesh: { glowReach: 1.2000000000000002 } });
    expect(sanitized.boardsesh.glowReach).toBe(1.2);
    expect(boardseshSignature({ glowReach: 1.2000000000000002 })).toBe(boardseshSignature({ glowReach: 1.2 }));
  });

  it('falls back to the defaults for junk, not to a NaN the renderer would ignore', () => {
    const sanitized = sanitizeBoardRenderSettings({
      mode: 'psychedelic',
      boardsesh: {
        glowFalloff: 'strobe',
        glowReach: 'wide',
        plateauShare: Number.NaN,
        veil: 42,
        markStyle: null,
        fillOpacity: Number.POSITIVE_INFINITY,
        softDisc: 'yes',
        smallHoldBoost: 0,
        ledDots: undefined,
        roleGlyphs: [],
        thumbnailStyle: 'glow-fill',
      },
    });

    expect(sanitized).toEqual(DEFAULT_BOARD_RENDER_SETTINGS);
  });

  it('reads a pre-2.4 stored mode of "boardsesh" as Aura', () => {
    // The rename is app-level only, so a settings file written by 2.3 still
    // says `boardsesh`. Without the migration `pickOption` rejects it and falls
    // back to `default`, which `decideBoardLookStep` reads as "never picked a
    // look" — re-opening the one-time board-look step for everyone who already
    // answered it.
    expect(sanitizeBoardRenderSettings({ mode: 'boardsesh' }).mode).toBe('aura');
  });

  it('reads a completely absent payload as the defaults', () => {
    expect(sanitizeBoardRenderSettings(null)).toEqual(DEFAULT_BOARD_RENDER_SETTINGS);
    expect(sanitizeBoardRenderSettings('boardsesh')).toEqual(DEFAULT_BOARD_RENDER_SETTINGS);
    expect(sanitizeBoardRenderSettings({ boardsesh: 'all of them' })).toEqual(DEFAULT_BOARD_RENDER_SETTINGS);
  });

  it('keeps every value a climber could legitimately have chosen', () => {
    const chosen = settingsWith({
      glowFalloff: 'plateau',
      glowReach: 1.4,
      plateauShare: 0.55,
      veil: 'custom',
      veilOpacity: 0.75,
      markStyle: 'fill',
      fillOpacity: 0.8,
      softDisc: true,
      smallHoldBoost: false,
      ledDots: false,
      roleGlyphs: true,
      thumbnailStyle: 'glow',
    });

    expect(sanitizeBoardRenderSettings(chosen)).toEqual(chosen);
  });
});

describe('persistence', () => {
  it('round-trips a chosen setting through storage', async () => {
    await setBoardRenderModePreference('aura');
    await setBoardseshRenderFieldPreference('glowFalloff', 'plateau');
    await setBoardseshRenderFieldPreference('glowReach', 1.4);

    _resetBoardRenderSettingsForTests();
    const reloaded = await loadBoardRenderSettings();

    expect(reloaded.mode).toBe('aura');
    expect(reloaded.boardsesh.glowFalloff).toBe('plateau');
    expect(reloaded.boardsesh.glowReach).toBe(1.4);
    // Untouched fields come back as the current defaults, not as whatever the
    // build that wrote the file happened to default to.
    expect(reloaded.boardsesh.markStyle).toBe(DEFAULT_BOARDSESH_RENDER_SETTINGS.markStyle);
  });

  it('stores nothing at all for an untouched install', async () => {
    await setBoardRenderSettingsPreference(DEFAULT_BOARD_RENDER_SETTINGS);
    expect(storage.has(STORAGE_KEY)).toBe(false);
  });

  it('stores only the fields that moved', async () => {
    await setBoardseshRenderFieldPreference('roleGlyphs', true);
    expect(JSON.parse(storage.get(STORAGE_KEY) ?? 'null')).toEqual({ boardsesh: { roleGlyphs: true } });
  });

  it('clears the file when a climber resets', async () => {
    await setBoardRenderModePreference('aura');
    expect(storage.has(STORAGE_KEY)).toBe(true);

    await resetBoardRenderSettings();

    expect(storage.has(STORAGE_KEY)).toBe(false);
    expect((await loadBoardRenderSettings()).mode).toBe('default');
  });

  it('clamps a hand-edited preference file on the way in', async () => {
    storage.set(STORAGE_KEY, JSON.stringify({ mode: 'aura', boardsesh: { glowReach: 99, veil: 'shimmer' } }));

    const loaded = await loadBoardRenderSettings();

    expect(loaded.boardsesh.glowReach).toBe(BOARD_RENDER_SETTING_BOUNDS.glowReach.max);
    expect(loaded.boardsesh.veil).toBe('auto');
  });
});

describe('resolveEffectiveRenderSettings', () => {
  it('resolves `default` to the Boardsesh drawing, the 2.4 app default', () => {
    const effective = resolveEffectiveRenderSettings(DEFAULT_BOARD_RENDER_SETTINGS, true);
    expect(effective.mode).toBe('aura');
    expect(effective.glowFalloff).toBe('soft');
    expect(effective.glowFalloffSource).toBe('default');
  });

  it('falls back to the shipped falloff, with no flag left to say otherwise', () => {
    const effective = resolveEffectiveRenderSettings(DEFAULT_BOARD_RENDER_SETTINGS, true);
    expect(effective.glowFalloff).toBe('soft');
    expect(effective.glowFalloffSource).toBe('default');
  });

  it('lets the climber overrule the app default', () => {
    const chosenClassic = resolveEffectiveRenderSettings(settingsWith({}, 'classic'), true);
    expect(chosenClassic.mode).toBe('classic');

    // `plateau`, not `soft`: soft is also the fallback, so choosing it would
    // pass whether or not the climber's pick was honoured.
    const chosenPlateau = resolveEffectiveRenderSettings(settingsWith({ glowFalloff: 'plateau' }), true);
    expect(chosenPlateau.glowFalloff).toBe('plateau');
    expect(chosenPlateau.glowFalloffSource).toBe('user');
  });

  it('forces classic when the installed renderer cannot draw the mode', () => {
    // The whole safety property of the probe: a library that predates the mode
    // accepts the config, ignores every field, and hands back a classic render.
    // This is the ONLY thing standing between a 2.3 binary and a board drawn in
    // a mode it cannot draw, now that the rollout flag is gone.
    const effective = resolveEffectiveRenderSettings(settingsWith({}), false);
    expect(effective.mode).toBe('classic');
    expect(effective.rendererAvailable).toBe(false);
  });

  it('answers the requested mode without allocating a settings object', () => {
    expect(requestedBoardRenderMode(DEFAULT_BOARD_RENDER_SETTINGS)).toBe('aura');
    expect(requestedBoardRenderMode(settingsWith({}, 'classic'))).toBe('classic');
    expect(requestedBoardRenderMode(settingsWith({}))).toBe('aura');
  });
});

describe('the editing-surface veil ceiling', () => {
  it('is the soft bucket — one of the two washes the measurement itself picks', () => {
    expect(EDITING_MAX_VEIL_OPACITY).toBe(VEIL_SETTING_OPACITY.soft);
    expect(EDITING_MAX_VEIL_OPACITY).toBe(VEIL_TUNING.veilSoftOpacity);
  });

  it('sits below the strong bucket, which is the wash it exists to cap', () => {
    expect(EDITING_MAX_VEIL_OPACITY).toBeLessThan(VEIL_SETTING_OPACITY.strong);
  });
});

describe('resolveVeilOpacity', () => {
  const brightWall = { mean: 0.741, coverage: 0.962 };

  it('measures the board’s own wall against the field under `auto`', () => {
    expect(resolveVeilOpacity(DEFAULT_BOARDSESH_RENDER_SETTINGS, brightWall, DARK_FIELD)).toBe(0.6);
    // Every board's wall is darker than a white field, so there is nothing to
    // quiet and the veil turns itself off.
    expect(resolveVeilOpacity(DEFAULT_BOARDSESH_RENDER_SETTINGS, brightWall, '#FFFFFF')).toBe(0);
  });

  it('is off for a board the tracer skipped rather than washing an unmeasured wall', () => {
    expect(resolveVeilOpacity(DEFAULT_BOARDSESH_RENDER_SETTINGS, null, DARK_FIELD)).toBe(0);
  });

  it('honours each fixed choice over the measurement', () => {
    const settings = DEFAULT_BOARDSESH_RENDER_SETTINGS;
    expect(resolveVeilOpacity({ ...settings, veil: 'off' }, brightWall, DARK_FIELD)).toBe(0);
    expect(resolveVeilOpacity({ ...settings, veil: 'soft' }, brightWall, DARK_FIELD)).toBe(0.3);
    expect(resolveVeilOpacity({ ...settings, veil: 'strong' }, { mean: 0.2, coverage: 1 }, DARK_FIELD)).toBe(0.6);
    expect(resolveVeilOpacity({ ...settings, veil: 'custom', veilOpacity: 0.42 }, null, DARK_FIELD)).toBe(0.42);
  });
});

describe('buildBoardRenderSignature', () => {
  it('is empty for a classic render, so the cache key is what it always was', () => {
    // Explicitly classic, not the app default — since 2.4 `mode: 'default'`
    // resolves to the Boardsesh drawing, so the default settings would sign as
    // boardsesh and this would stop testing what it names.
    const classic = resolveEffectiveRenderSettings(settingsWith({}, 'classic'), true);
    expect(buildBoardRenderSignature(classic, DARK_FIELD, 0.6)).toBe('');
  });

  it('names the mode and the veil, and omits every setting still at its default', () => {
    expect(boardseshSignature({})).toBe('mode-boardsesh.veil-181225-60');
  });

  it('says so out loud when the veil is off, rather than dropping the token', () => {
    // A theme flip has to change the key: the wash is baked into the PNG, so a
    // light-mode overlay reused in dark mode would show an unquieted wall.
    expect(boardseshSignature({}, 0)).toBe('mode-boardsesh.veil-off');
    expect(boardseshSignature({}, 0)).not.toBe(boardseshSignature({}, 0.6));
  });

  it('is deterministic for the same settings', () => {
    const chosen = { glowFalloff: 'plateau' as const, glowReach: 1.2, softDisc: true };
    expect(boardseshSignature(chosen)).toBe(boardseshSignature(chosen));
  });

  /**
   * One non-default value per `BoardseshRenderSettings` field, keyed by the
   * type itself — a 13th field is a compile error here until it is listed, so
   * the it.each below (driven off `DEFAULT_BOARDSESH_RENDER_SETTINGS`'s own
   * keys) can never silently skip a token the renderer reads.
   */
  const MOVED_OFF_DEFAULT: { [K in keyof BoardseshRenderSettings]: BoardseshRenderSettings[K] } = {
    glowFalloff: 'plateau',
    glowReach: 1.2,
    plateauShare: 0.55,
    veil: 'strong',
    veilOpacity: 0.5,
    markStyle: 'glow-fill',
    fillOpacity: 0.8,
    softDisc: true,
    smallHoldBoost: false,
    ledDots: false,
    roleGlyphs: true,
    thumbnailStyle: 'glow',
    holdShape: 'circle',
  };

  /** The substring `buildBoardRenderSignature` mints for each field above. */
  const EXPECTED_TOKEN: { [K in keyof BoardseshRenderSettings]: string } = {
    glowFalloff: 'glow-plateau',
    glowReach: 'reach-1.2',
    plateauShare: 'plateau-0.55',
    // `strong` always resolves to 0.6, against `auto`'s 0.3 under WALL_ROW.
    veil: 'veil-181225-60',
    // Paired with `veil: 'custom'` below — 0.5 only reaches the resolver then.
    veilOpacity: 'veil-181225-50',
    markStyle: 'marks-glow-fill',
    fillOpacity: 'fill-0.8',
    softDisc: 'disc',
    smallHoldBoost: 'noboost',
    ledDots: 'noleds',
    roleGlyphs: 'glyphs',
    thumbnailStyle: 'thumb-glow',
    holdShape: 'shape-circle',
  };

  /**
   * `veilOpacity` only reaches `resolveVeilOpacity` when `veil` is `'custom'`
   * — paired here so moving this field alone actually changes the resolved
   * opacity, rather than silently doing nothing under the still-`'auto'`
   * default a raw override would otherwise leave in place.
   */
  function overrideFor(field: keyof BoardseshRenderSettings): Partial<BoardseshRenderSettings> {
    if (field === 'veilOpacity') return { veil: 'custom', veilOpacity: MOVED_OFF_DEFAULT.veilOpacity };
    return { [field]: MOVED_OFF_DEFAULT[field] } as Partial<BoardseshRenderSettings>;
  }

  // Gap to the dark field lands in the soft bucket (0.175-0.34), so `auto`
  // resolves to 0.3 here — different from both `strong` (always 0.6) and a
  // `custom` 0.5, which is what lets `veil` and `veilOpacity` prove they move
  // the signature too, resolved through `resolveVeilOpacity` the way a real
  // render resolves them rather than as a raw, unresolved override.
  const WALL_ROW = { mean: 0.45, coverage: 1 };

  function resolvedBoardseshSignature(overrides: Partial<BoardseshRenderSettings>): string {
    const settings = sanitizeBoardRenderSettings(settingsWith(overrides));
    const effective = resolveEffectiveRenderSettings(settings, true);
    const veilOpacity = resolveVeilOpacity(effective.boardsesh, WALL_ROW, DARK_FIELD);
    return buildBoardRenderSignature(effective, DARK_FIELD, veilOpacity);
  }

  it.each(Object.keys(DEFAULT_BOARDSESH_RENDER_SETTINGS) as (keyof BoardseshRenderSettings)[])(
    'changes the signature when %s moves off its default',
    (field) => {
      const moved = resolvedBoardseshSignature(overrideFor(field));
      expect(moved).not.toBe(resolvedBoardseshSignature({}));
      // Substring, not a split on '.': a numeric token carries its own decimal
      // point. The signature is an opaque cache-key fragment and is never
      // parsed back apart, so that costs nothing.
      expect(moved).toContain(EXPECTED_TOKEN[field]);
    },
  );

  it('spells the veil out as field colour and percent', () => {
    expect(boardseshSignature({}, 0.3)).toContain('veil-181225-30');
    expect(
      buildBoardRenderSignature(resolveEffectiveRenderSettings(settingsWith({}), true), '#FFFFFF', 0.05),
    ).toContain('veil-ffffff-05');
  });

  it('collapses two veil choices that resolve to the same wash', () => {
    // `strong` and a `custom` 0.6 draw the same pixels; splitting the cache on
    // the label rather than the wash would render the same PNG twice.
    expect(boardseshSignature({ veil: 'strong' }, 0.6)).toBe(
      boardseshSignature({ veil: 'custom', veilOpacity: 0.6 }, 0.6),
    );
  });
});

describe('screenshot builds pin the drawing', () => {
  const originalScreenshotMode = process.env.EXPO_PUBLIC_SCREENSHOT_MODE;
  const originalRenderMode = process.env.EXPO_PUBLIC_SCREENSHOT_RENDER_MODE;

  afterEach(() => {
    if (originalScreenshotMode === undefined) delete process.env.EXPO_PUBLIC_SCREENSHOT_MODE;
    else process.env.EXPO_PUBLIC_SCREENSHOT_MODE = originalScreenshotMode;
    if (originalRenderMode === undefined) delete process.env.EXPO_PUBLIC_SCREENSHOT_RENDER_MODE;
    else process.env.EXPO_PUBLIC_SCREENSHOT_RENDER_MODE = originalRenderMode;
    vi.resetModules();
  });

  // The store set exists to show the shipped look; a preference file surviving a
  // reinstall (or a default moving) must not be able to change what it shoots.
  it('ignores a stored preference and asks for Aura', async () => {
    storage.set(STORAGE_KEY, JSON.stringify({ mode: 'classic' }));
    process.env.EXPO_PUBLIC_SCREENSHOT_MODE = '1';
    vi.resetModules();

    const { loadBoardRenderSettings: loadPinned } = await import('../board-render-settings');

    expect((await loadPinned()).mode).toBe('aura');
  });

  it('shoots the classic look when the run asks for it', async () => {
    process.env.EXPO_PUBLIC_SCREENSHOT_MODE = '1';
    process.env.EXPO_PUBLIC_SCREENSHOT_RENDER_MODE = 'classic';
    vi.resetModules();

    const { loadBoardRenderSettings: loadPinned } = await import('../board-render-settings');

    expect((await loadPinned()).mode).toBe('classic');
  });

  // `default` is the stored value that MEANS "whatever the app draws"; this is the
  // storage layer, so it is what an unusable override has to land on.
  // `requestedBoardRenderMode` is what turns it into a drawing.
  it('stores the app default for a render mode it does not recognise', async () => {
    process.env.EXPO_PUBLIC_SCREENSHOT_MODE = '1';
    process.env.EXPO_PUBLIC_SCREENSHOT_RENDER_MODE = 'shimmer';
    vi.resetModules();

    const { loadBoardRenderSettings: loadPinned } = await import('../board-render-settings');

    expect((await loadPinned()).mode).toBe('default');
  });
});
