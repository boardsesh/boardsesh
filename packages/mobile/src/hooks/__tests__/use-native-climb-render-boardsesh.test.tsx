// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { getWallLightness } from '@boardsesh/board-art-geometry';

// Issue #2202: the Boardsesh drawing — a wash of the play field over the unlit
// wall, a glow clipped to each lit hold's traced silhouette, and a HAND blue
// that survives that wash. Everything here is pinned against the REAL shards in
// @boardsesh/board-art-geometry; a fixture would let the outline plumbing pass
// while the traced ids it reads were wrong.

const appColorScheme = vi.hoisted(() => ({ current: 'dark' as 'light' | 'dark' }));
vi.mock('../../providers/theme-provider', () => ({
  useAppColorScheme: () => appColorScheme.current,
}));

vi.mock('expo-file-system', () => ({
  Directory: vi.fn(() => ({ exists: false, list: () => [] })),
  File: vi.fn(() => ({ exists: false })),
  Paths: { cache: { uri: 'file:///cache/' } },
}));

type MockBoardRenderData = {
  boardWidth: number;
  boardHeight: number;
  holdsData: { id: number; mirroredHoldId: number | null; cx: number; cy: number; r: number }[];
};
const getBoardRenderDataMock = vi.hoisted(() => vi.fn<() => MockBoardRenderData | null>(() => null));
vi.mock('../../lib/board-details', () => ({ getBoardRenderData: getBoardRenderDataMock }));

vi.mock('../../lib/background-image-cache', () => ({
  tryGetBackgroundPathsSync: vi.fn(() => ({ paths: ['file:///bg.png'], missingCount: 0 })),
  ensureBackgroundsCached: vi.fn(async () => ({ paths: ['file:///bg.png'], missingCount: 0 })),
}));

const reportErrorMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/error-reporting', () => ({ reportError: reportErrorMock }));

// The store hydrates from AsyncStorage; the hook only ever reads its snapshot,
// so the suite drives that snapshot directly. Referentially stable per case —
// a fresh object every render would re-fire the overlay effect on every tick.
const boardRenderSettingsRef = vi.hoisted(() => ({
  current: {
    mode: 'default' as 'default' | 'classic' | 'boardsesh',
    boardsesh: {
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
    },
  },
}));
vi.mock('../../lib/board-render-settings', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/board-render-settings')>();
  return {
    ...original,
    useBoardRenderSettings: () => ({
      settings: boardRenderSettingsRef.current,
      loaded: true,
      setMode: () => {},
      setBoardseshField: () => {},
      reset: () => {},
    }),
  };
});

const {
  BOARD_FIELD_COLORS,
  DEFAULT_BOARDSESH_RENDER_SETTINGS,
  DEFAULT_BOARD_RENDER_SETTINGS,
  buildBoardRenderSignature,
  resolveEffectiveRenderSettings,
  resolveVeilOpacity,
} = await import('../../lib/board-render-settings');

const {
  useNativeClimbRender,
  buildCacheKey,
  _getBoardConfigForTests,
  _resetBoardConfigCacheForTests,
  _resetWarmupForTests,
  _resetBoardseshSupportForTests,
  _getBoardseshSupportForTests,
  _renderedOverlaysForTests,
  _inflightRendersForTests,
  _unsupportedRenderSignaturesForTests,
  _setNativeModuleForTests,
  _BOARDSESH_RENDERER_UNAVAILABLE_MESSAGE_FOR_TESTS,
} = await import('../use-native-climb-render');

type BoardseshRenderSettings = typeof DEFAULT_BOARDSESH_RENDER_SETTINGS;
type BoardseshConfigInputs = NonNullable<Parameters<typeof _getBoardConfigForTests>[11]>;

const DARK_FIELD = BOARD_FIELD_COLORS.dark;
const LIGHT_FIELD = BOARD_FIELD_COLORS.light;

/**
 * Grasshopper 2020, 12x12 (layout 1, size 5) — the one board family whose art
 * paints bright LEDs, so it is the only place `led` and `led_cover` are real.
 * Placements 1 and 2 carry an outline AND a painted LED; 27 carries an outline
 * and no LED.
 */
const GRASSHOPPER = { boardName: 'grasshopper' as const, layoutId: 1, sizeId: 5, setIds: '1' };
const GRASSHOPPER_HOLDS: MockBoardRenderData = {
  boardWidth: 1080,
  boardHeight: 1080,
  holdsData: [
    { id: 1, mirroredHoldId: null, cx: 100, cy: 200, r: 20 },
    { id: 2, mirroredHoldId: null, cx: 160, cy: 200, r: 20 },
    { id: 27, mirroredHoldId: null, cx: 220, cy: 200, r: 20 },
  ],
};
/** Only placement 1 is lit — role code 2 is Grasshopper's HAND. */
const GRASSHOPPER_FRAMES = 'p1r2';

/** Tension Board 2 Mirror, 12x12 (layout 10, size 6) — the strong-veil board. */
const TB2_MIRROR = { boardName: 'tension' as const, layoutId: 10, sizeId: 6, setIds: '20' };
/** Tension Original Layout (layout 9, size 1) — the other strong-veil board. */
const TENSION_ORIGINAL = { boardName: 'tension' as const, layoutId: 9, sizeId: 1, setIds: '10' };
const TENSION_HOLDS: MockBoardRenderData = {
  boardWidth: 1080,
  boardHeight: 1080,
  holdsData: [{ id: 304, mirroredHoldId: null, cx: 100, cy: 200, r: 20 }],
};

function asRecord(value: unknown): Record<string, unknown> {
  expect(value && typeof value === 'object' && !Array.isArray(value)).toBe(true);
  return value as Record<string, unknown>;
}

function boardseshInputs(
  overrides: Partial<BoardseshRenderSettings> = {},
  options: { fieldColor?: string; veilOpacity?: number; glowFalloff?: 'soft' | 'plateau' } = {},
): BoardseshConfigInputs {
  return {
    settings: { ...DEFAULT_BOARDSESH_RENDER_SETTINGS, ...overrides },
    glowFalloff: options.glowFalloff ?? 'soft',
    fieldColor: options.fieldColor ?? DARK_FIELD,
    veilOpacity: options.veilOpacity ?? 0.6,
  };
}

type BoardConfigArgs = { boardName: string; layoutId: number; sizeId: number; setIds: string };
function buildConfig(
  board: BoardConfigArgs,
  {
    filledStyle = false,
    boardsesh = null,
    frames = '',
    renderSignature = 'default',
    colorOverrides = {},
  }: {
    filledStyle?: boolean;
    boardsesh?: BoardseshConfigInputs | null;
    frames?: string;
    renderSignature?: string;
    colorOverrides?: Record<string, string>;
  } = {},
): Record<string, unknown> {
  const boardConfig = _getBoardConfigForTests(
    board.boardName as Parameters<typeof _getBoardConfigForTests>[0],
    board.layoutId,
    board.sizeId,
    board.setIds,
    filledStyle,
    undefined,
    colorOverrides,
    {},
    1,
    1,
    renderSignature,
    boardsesh,
    frames,
  );
  expect(boardConfig).not.toBeNull();
  return asRecord(boardConfig?.configBase);
}

function holdById(configBase: Record<string, unknown>, holdId: number): Record<string, unknown> {
  const holds = configBase.holds as Record<string, unknown>[];
  const hold = holds.find((candidate) => candidate.id === holdId);
  expect(hold).toBeDefined();
  return asRecord(hold);
}

function stateInfoByColorRole(
  configBase: Record<string, unknown>,
  roleCode: number,
): Record<string, unknown> | undefined {
  const holdStateMap = asRecord(configBase.hold_state_map);
  return holdStateMap[roleCode] as Record<string, unknown> | undefined;
}

beforeEach(() => {
  _resetBoardConfigCacheForTests();
  _resetWarmupForTests();
  _resetBoardseshSupportForTests();
  _renderedOverlaysForTests.clear();
  _inflightRendersForTests.clear();
  _unsupportedRenderSignaturesForTests.clear();
  reportErrorMock.mockClear();
  appColorScheme.current = 'dark';
  boardRenderSettingsRef.current = { ...DEFAULT_BOARD_RENDER_SETTINGS, mode: 'default' };
  getBoardRenderDataMock.mockReturnValue(GRASSHOPPER_HOLDS);
});

describe('the refusal message', () => {
  it('matches the wrapper that throws it', async () => {
    // The hook restates the string rather than importing it — a static import
    // would pull the native-module wrapper (and expo-modules-core with it) into
    // every consumer of this hook. The web twin exports the same constant as the
    // native one, so pinning against it keeps the copy honest.
    const { BOARDSESH_RENDERER_UNAVAILABLE_MESSAGE } = await import('../../../modules/board-renderer/src/index.web');
    expect(_BOARDSESH_RENDERER_UNAVAILABLE_MESSAGE_FOR_TESTS).toBe(BOARDSESH_RENDERER_UNAVAILABLE_MESSAGE);
  });
});

describe('classic configs are untouched', () => {
  it('emits exactly the fields it always has, in the order it always has', () => {
    const configBase = buildConfig(GRASSHOPPER, { frames: GRASSHOPPER_FRAMES });

    expect(Object.keys(configBase)).toEqual([
      'board_width',
      'board_height',
      'output_width',
      'mirrored',
      'thumbnail',
      'stroke_width_multiplier',
      'shape_size_multiplier',
      'holds',
      'hold_state_map',
    ]);
  });

  it('leaves every hold at the five classic fields, even on a board with traced art', () => {
    const configBase = buildConfig(GRASSHOPPER, { frames: GRASSHOPPER_FRAMES });
    expect(Object.keys(holdById(configBase, 1))).toEqual(['id', 'mirroredHoldId', 'cx', 'cy', 'r']);
  });

  it('gives no hold state a glyph role', () => {
    const configBase = buildConfig(GRASSHOPPER, { frames: GRASSHOPPER_FRAMES });
    const holdStateMap = asRecord(configBase.hold_state_map);
    expect(Object.values(holdStateMap).every((stateInfo) => asRecord(stateInfo).role === undefined)).toBe(true);
  });

  it('keeps the classic HAND blue', () => {
    getBoardRenderDataMock.mockReturnValue(TENSION_HOLDS);
    const configBase = buildConfig(TB2_MIRROR, { frames: 'p304r2' });
    expect(stateInfoByColorRole(configBase, 2)?.color).toBe('#4444FF');
  });
});

describe('the Boardsesh config', () => {
  it('emits every board-level field at the shipped defaults', () => {
    const configBase = buildConfig(GRASSHOPPER, {
      frames: GRASSHOPPER_FRAMES,
      boardsesh: boardseshInputs(),
      renderSignature: 'default.mode-boardsesh.veil-181225-60',
    });

    expect(configBase.render_mode).toBe('boardsesh');
    expect(configBase.veil).toEqual({ color: DARK_FIELD, opacity: 0.6 });
    expect(configBase.mark_style).toBe('glow');
    expect(configBase.glow_falloff).toBe('soft');
    expect(configBase.glow).toEqual({
      reach_scale: 1,
      plateau_share: 0.4,
      disc_opacity: 0,
      small_hold_max_boost: 1.7,
    });
    expect(configBase.fill).toEqual({ opacity: 0.55 });
    expect(configBase.glyphs).toBe('off');
    // Grasshopper's art paints its LEDs bright, so the cover is real here.
    expect(configBase.led_cover).toEqual({});
  });

  it('leaves the veil out entirely rather than sending a zero-opacity wash', () => {
    const configBase = buildConfig(GRASSHOPPER, {
      frames: GRASSHOPPER_FRAMES,
      boardsesh: boardseshInputs({}, { fieldColor: LIGHT_FIELD, veilOpacity: 0 }),
      renderSignature: 'default.mode-boardsesh.veil-off',
    });

    expect(configBase.render_mode).toBe('boardsesh');
    expect('veil' in configBase).toBe(false);
  });

  it('carries each knob through to the field the renderer reads', () => {
    const configBase = buildConfig(GRASSHOPPER, {
      frames: GRASSHOPPER_FRAMES,
      boardsesh: boardseshInputs(
        {
          glowReach: 1.5,
          plateauShare: 0.55,
          softDisc: true,
          smallHoldBoost: false,
          fillOpacity: 0.8,
          markStyle: 'fill',
          roleGlyphs: true,
          ledDots: false,
        },
        { glowFalloff: 'plateau' },
      ),
      renderSignature: 'everything-moved',
    });

    expect(configBase.glow_falloff).toBe('plateau');
    expect(configBase.glow).toEqual({
      reach_scale: 1.5,
      plateau_share: 0.55,
      disc_opacity: 0.3,
      small_hold_max_boost: 1,
    });
    expect(configBase.fill).toEqual({ opacity: 0.8 });
    expect(configBase.mark_style).toBe('fill');
    expect(configBase.glyphs).toBe('role');
    expect('led_cover' in configBase).toBe(false);
  });

  it('lower-cases the four roles the glyph vocabulary covers, and skips the rest', () => {
    getBoardRenderDataMock.mockReturnValue(TENSION_HOLDS);
    const tensionConfig = buildConfig(TB2_MIRROR, {
      frames: 'p304r2',
      boardsesh: boardseshInputs(),
      renderSignature: 'boardsesh-roles',
    });

    expect(stateInfoByColorRole(tensionConfig, 1)?.role).toBe('starting');
    expect(stateInfoByColorRole(tensionConfig, 2)?.role).toBe('hand');
    expect(stateInfoByColorRole(tensionConfig, 3)?.role).toBe('finish');
    expect(stateInfoByColorRole(tensionConfig, 4)?.role).toBe('foot');

    // MoonBoard's AUX has no glyph, so it is left without a role rather than
    // handed one the renderer would draw wrong.
    const moonboardConfig = buildConfig(
      { boardName: 'moonboard', layoutId: 1, sizeId: 1, setIds: '1' },
      { frames: 'p1r43', boardsesh: boardseshInputs(), renderSignature: 'boardsesh-roles' },
    );
    expect(stateInfoByColorRole(moonboardConfig, 43)?.role).toBe('hand');
    expect(stateInfoByColorRole(moonboardConfig, 46)?.role).toBeUndefined();
  });

  it('lifts the dark-blue HAND to #6980FF, and still lets the climber overrule it', () => {
    getBoardRenderDataMock.mockReturnValue(TENSION_HOLDS);

    const boardseshConfig = buildConfig(TB2_MIRROR, {
      frames: 'p304r2',
      boardsesh: boardseshInputs(),
      renderSignature: 'boardsesh-hand',
    });
    expect(stateInfoByColorRole(boardseshConfig, 2)?.color).toBe('#6980FF');

    const overriddenConfig = buildConfig(TB2_MIRROR, {
      frames: 'p304r2',
      boardsesh: boardseshInputs(),
      colorOverrides: { HAND: '#ff0000' },
      renderSignature: 'boardsesh-hand-override',
    });
    expect(stateInfoByColorRole(overriddenConfig, 2)?.color).toBe('#ff0000');
  });

  it.each([
    ['the full-size play view', false, 'fill' as const, 'glow'],
    ['a thumbnail, whose bare glow reads faint at ~76px', true, 'fill' as const, 'glow-fill'],
    ['a thumbnail when the climber asked for the glow', true, 'glow' as const, 'glow'],
  ])('picks the mark style for %s', (_surface, filledStyle, thumbnailStyle, expected) => {
    const configBase = buildConfig(GRASSHOPPER, {
      filledStyle,
      frames: GRASSHOPPER_FRAMES,
      boardsesh: boardseshInputs({ thumbnailStyle }),
      renderSignature: `marks-${String(filledStyle)}-${thumbnailStyle}`,
    });
    expect(configBase.mark_style).toBe(expected);
  });
});

describe('per-hold geometry', () => {
  it('attaches the traced outline and its lightness to the lit holds only', () => {
    const configBase = buildConfig(GRASSHOPPER, {
      frames: GRASSHOPPER_FRAMES,
      boardsesh: boardseshInputs(),
      renderSignature: 'boardsesh-geometry',
    });

    const litHold = holdById(configBase, 1);
    expect(Array.isArray(litHold.outline)).toBe(true);
    expect((litHold.outline as number[]).length).toBeGreaterThanOrEqual(6);
    expect(typeof litHold.silhouette_lightness).toBe('number');

    // Placement 2 has a traced outline of its own — the renderer just has no
    // reason to draw it, and 190 KB of polygons no one draws is the cost.
    const unlitHold = holdById(configBase, 2);
    expect('outline' in unlitHold).toBe(false);
    expect('silhouette_lightness' in unlitHold).toBe(false);
  });

  it('gives the LED offset to every bright placement, lit or not', () => {
    const configBase = buildConfig(GRASSHOPPER, {
      frames: GRASSHOPPER_FRAMES,
      boardsesh: boardseshInputs(),
      renderSignature: 'boardsesh-geometry',
    });

    // An unlit hold's white pip is exactly what a climber mistakes for a mark,
    // so the cover has to reach the holds this climb does NOT light.
    expect(holdById(configBase, 1).led).toHaveLength(2);
    expect(holdById(configBase, 2).led).toHaveLength(2);
    // Placement 27's art paints no bright LED — there is nothing to cover.
    expect('led' in holdById(configBase, 27)).toBe(false);
  });

  it('still renders the mode on a board the tracer skipped, with no outlines at all', () => {
    // Woods' art is an opaque photo of the hold set, so there is no silhouette
    // in the alpha channel to find and the catalogue ships no shard.
    const configBase = buildConfig(
      { boardName: 'woods', layoutId: 1, sizeId: 1, setIds: '1' },
      { frames: 'p1r2', boardsesh: boardseshInputs(), renderSignature: 'boardsesh-woods' },
    );

    expect(configBase.render_mode).toBe('boardsesh');
    expect(configBase.veil).toEqual({ color: DARK_FIELD, opacity: 0.6 });
    const holds = configBase.holds as Record<string, unknown>[];
    expect(holds.every((hold) => !('outline' in hold) && !('led' in hold))).toBe(true);
    expect('led_cover' in configBase).toBe(false);
  });
});

describe('the veil, measured against the real shards', () => {
  it.each([
    ['Tension Board 2 Mirror 12x12', TB2_MIRROR],
    ['Tension Original Layout', TENSION_ORIGINAL],
  ])('washes %s at full strength on the dark field and not at all on the light one', (_name, board) => {
    const wall = getWallLightness(board);
    expect(wall).not.toBeNull();
    expect(resolveVeilOpacity(DEFAULT_BOARDSESH_RENDER_SETTINGS, wall, DARK_FIELD)).toBe(0.6);
    // Every board's wall is darker than white, so there is nothing to quiet.
    expect(resolveVeilOpacity(DEFAULT_BOARDSESH_RENDER_SETTINGS, wall, LIGHT_FIELD)).toBe(0);
  });

  it('drops to the soft wash on a board whose wall is closer to the field', () => {
    expect(resolveVeilOpacity(DEFAULT_BOARDSESH_RENDER_SETTINGS, getWallLightness(GRASSHOPPER), DARK_FIELD)).toBe(0.3);
  });
});

describe('the cache key', () => {
  const CLIMB = { boardName: 'grasshopper', layoutId: 1, sizeId: 5, setIds: '1' };

  function keyFor(boardSignature: string): string {
    const composed = ['default', boardSignature].filter(Boolean).join('.');
    return buildCacheKey(
      CLIMB.boardName,
      CLIMB.layoutId,
      CLIMB.sizeId,
      CLIMB.setIds,
      GRASSHOPPER_FRAMES,
      false,
      undefined,
      composed,
    );
  }

  function signatureFor(
    overrides: Partial<BoardseshRenderSettings>,
    fieldColor: string = DARK_FIELD,
    veilOpacity = 0.6,
  ) {
    return buildBoardRenderSignature(
      resolveEffectiveRenderSettings(
        { mode: 'boardsesh', boardsesh: { ...DEFAULT_BOARDSESH_RENDER_SETTINGS, ...overrides } },
        undefined,
        true,
      ),
      fieldColor,
      veilOpacity,
    );
  }

  it('carries the current renderer version and is otherwise the classic key', () => {
    const classicKey = keyFor('');
    expect(classicKey).toMatch(/^v7_/);
    expect(classicKey).toBe(
      buildCacheKey(CLIMB.boardName, CLIMB.layoutId, CLIMB.sizeId, CLIMB.setIds, GRASSHOPPER_FRAMES),
    );
  });

  it('separates a Boardsesh render from the classic one', () => {
    expect(keyFor(signatureFor({}))).not.toBe(keyFor(''));
  });

  it.each([
    ['glowFalloff', { glowFalloff: 'plateau' as const }],
    ['glowReach', { glowReach: 1.5 }],
    ['plateauShare', { plateauShare: 0.55 }],
    ['markStyle', { markStyle: 'fill' as const }],
    ['fillOpacity', { fillOpacity: 0.8 }],
    ['softDisc', { softDisc: true }],
    ['smallHoldBoost', { smallHoldBoost: false }],
    ['ledDots', { ledDots: false }],
    ['roleGlyphs', { roleGlyphs: true }],
    ['thumbnailStyle', { thumbnailStyle: 'glow' as const }],
  ])('changes when %s changes', (_field, overrides) => {
    expect(keyFor(signatureFor(overrides))).not.toBe(keyFor(signatureFor({})));
  });

  it('changes when the theme flips the play field under the veil', () => {
    // Both halves of the flip move: the field colour the veil washes toward,
    // and the strength the measurement gives it on that field.
    expect(keyFor(signatureFor({}, LIGHT_FIELD, 0))).not.toBe(keyFor(signatureFor({}, DARK_FIELD, 0.6)));
  });
});

describe('useNativeClimbRender render mode', () => {
  const nativeModule = {
    boardRendererNative: {},
    renderHoldsOverlay: vi.fn<(configJson: string, cacheKey: string) => Promise<string>>(),
    probeBoardseshRendererSupport: vi.fn<() => Promise<boolean>>(),
  };

  function sentConfigs(): Record<string, unknown>[] {
    return nativeModule.renderHoldsOverlay.mock.calls.map(([configJson]) => JSON.parse(configJson));
  }

  beforeEach(() => {
    nativeModule.renderHoldsOverlay.mockReset();
    nativeModule.renderHoldsOverlay.mockResolvedValue('file:///overlay.png');
    nativeModule.probeBoardseshRendererSupport.mockReset();
    nativeModule.probeBoardseshRendererSupport.mockResolvedValue(true);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    _setNativeModuleForTests(nativeModule as unknown as Parameters<typeof _setNativeModuleForTests>[0]);
    boardRenderSettingsRef.current = { ...DEFAULT_BOARD_RENDER_SETTINGS, mode: 'boardsesh' };
  });

  it('never asks an unverified library for the mode, then switches once the probe says yes', async () => {
    const { result } = renderHook(() =>
      useNativeClimbRender({ ...GRASSHOPPER, frames: GRASSHOPPER_FRAMES, boardName: 'grasshopper' }),
    );

    // The first render goes out before the probe answers, and it is classic:
    // RenderConfig has no `deny_unknown_fields`, so a stale library would have
    // accepted a Boardsesh config, ignored it, and said nothing.
    expect(sentConfigs()[0]?.render_mode).toBeUndefined();

    await waitFor(() => expect(sentConfigs().some((config) => config.render_mode === 'boardsesh')).toBe(true));
    expect(result.current.boardseshRendererAvailable).toBe(true);
    expect(result.current.effectiveRenderSettings.mode).toBe('boardsesh');
  });

  it('bakes the theme’s field and the board’s measured wash into the config', async () => {
    renderHook(() => useNativeClimbRender({ ...GRASSHOPPER, frames: GRASSHOPPER_FRAMES, boardName: 'grasshopper' }));

    await waitFor(() => expect(sentConfigs().some((config) => config.render_mode === 'boardsesh')).toBe(true));
    const boardseshConfig = sentConfigs().find((config) => config.render_mode === 'boardsesh');
    // Grasshopper's wall sits close enough to the dark field for the soft wash.
    expect(boardseshConfig?.veil).toEqual({ color: DARK_FIELD, opacity: 0.3 });
  });

  it('stays classic when the probe says the library cannot draw it', async () => {
    nativeModule.probeBoardseshRendererSupport.mockResolvedValue(false);

    const { result } = renderHook(() =>
      useNativeClimbRender({ ...GRASSHOPPER, frames: GRASSHOPPER_FRAMES, boardName: 'grasshopper' }),
    );

    await waitFor(() => expect(result.current.boardseshRendererAvailable).toBe(false));
    await waitFor(() => expect(result.current.overlayUri).toBe('file:///overlay.png'));
    expect(sentConfigs().every((config) => config.render_mode === undefined)).toBe(true);
    expect(result.current.effectiveRenderSettings.mode).toBe('classic');
  });

  it('falls back to the classic drawing — for the whole app — when a render is refused', async () => {
    nativeModule.renderHoldsOverlay.mockImplementation(async (configJson: string) => {
      if ((JSON.parse(configJson) as { render_mode?: string }).render_mode === 'boardsesh') {
        throw new Error(_BOARDSESH_RENDERER_UNAVAILABLE_MESSAGE_FOR_TESTS);
      }
      return 'file:///overlay-classic.png';
    });

    const { result } = renderHook(() =>
      useNativeClimbRender({ ...GRASSHOPPER, frames: GRASSHOPPER_FRAMES, boardName: 'grasshopper' }),
    );

    await waitFor(() => expect(sentConfigs().some((config) => config.render_mode === 'boardsesh')).toBe(true));
    await waitFor(() => expect(_getBoardseshSupportForTests()).toBe(false));
    await waitFor(() => expect(result.current.overlayUri).toBe('file:///overlay-classic.png'));

    expect(result.current.effectiveRenderSettings.mode).toBe('classic');
    // A refusal is a designed capability fallback, not a defect worth paging on
    // — and it must not be recorded as an unsupported SIGNATURE, which would
    // drop the climber's marker overrides this binary draws perfectly well.
    expect(reportErrorMock).not.toHaveBeenCalled();
    expect(_unsupportedRenderSignaturesForTests.size).toBe(0);
  });
});
