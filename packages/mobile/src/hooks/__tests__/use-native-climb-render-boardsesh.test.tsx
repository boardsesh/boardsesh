// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { getWallLightness, loadBoardArtGeometry } from '@boardsesh/board-art-geometry';

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
vi.mock('../../lib/error-reporting', () => ({ reportError: reportErrorMock, addErrorBreadcrumb: vi.fn() }));

// The store hydrates from AsyncStorage; the hook only ever reads its snapshot,
// so the suite drives that snapshot directly. Referentially stable per case —
// a fresh object every render would re-fire the overlay effect on every tick.
const boardRenderSettingsRef = vi.hoisted(() => ({
  current: {
    mode: 'default' as 'default' | 'classic' | 'aura',
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
// Process warmth: the GPU-first cases run warm unless a test says otherwise.
const gpuWarmth = vi.hoisted(() => ({ allWarm: true, warmKeys: new Set<string>() }));
vi.mock('../../lib/board-render/gpu-warm-configs', () => ({
  isGpuConfigWarm: (gpuWarmKey: string) => gpuWarmth.allWarm || gpuWarmth.warmKeys.has(gpuWarmKey),
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
  EDITING_VEIL_OPACITY,
} = await import('../../lib/board-render-settings');

const {
  useNativeClimbRender,
  buildCacheKey,
  _getBoardConfigForTests,
  _resetBoardConfigCacheForTests,
  _resetBoardHoldIdsCacheForTests,
  _resetWarmupForTests,
  _resetBoardseshSupportForTests,
  _getBoardseshSupportForTests,
  _renderedOverlaysForTests,
  _inflightRendersForTests,
  _unsupportedRenderSignaturesForTests,
  _setNativeModuleForTests,
  _resetNativeModuleLoadForTests,
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

/**
 * Woods 8x10 (layout 1, size 1) — the one board traced off a white key rather
 * than off an alpha channel, because its art is a photograph of the hold set on
 * a white sweep. Fed to the REAL `getBoardRenderData` wherever the traced ids
 * matter; the reach cases below only read board-level fields, so they take the
 * canned holds like every other board here.
 */
const WOODS_8X10 = { boardName: 'woods' as const, layoutId: 1, sizeId: 1, setIds: '1' };
/** Woods' own scale: an 11.5 px radius on 720 px-wide art (`WOODS_HOLD_RADIUS_PX` / `WOODS_GEOMETRY`). */
const WOODS_HOLDS: MockBoardRenderData = {
  boardWidth: 720,
  boardHeight: 1000,
  holdsData: [{ id: 1, mirroredHoldId: null, cx: 100, cy: 200, r: 11.5 }],
};

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
  gpuWarmth.allWarm = true;
  gpuWarmth.warmKeys.clear();
  _resetBoardConfigCacheForTests();
  _resetBoardHoldIdsCacheForTests();
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

    expect(configBase.render_mode).toBe('aura');
    expect(configBase.veil).toEqual({ color: DARK_FIELD, opacity: 0.6 });
    expect(configBase.mark_style).toBe('glow');
    expect(configBase.glow_falloff).toBe('soft');
    // The shipped default includes Boardsesh Aura's bundle: wider spread,
    // fused same-colour neighbours, the capped different-colour crossfade,
    // and the deepened fringe.
    expect(configBase.glow).toEqual({
      reach_scale: 1,
      plateau_share: 0.4,
      disc_opacity: 0,
      small_hold_max_boost: 1.7,
      spread_fraction: 0.91,
      merge_softness: 0.6,
      seam_blend_fraction: 0.9,
      seam_sharpness: 3,
      fringe_deepen: 0.4,
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

    expect(configBase.render_mode).toBe('aura');
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
    // The climber's knobs and the Aura bundle co-exist: reach_scale is the
    // slider's (it multiplies on top of the bundle's spread_fraction).
    expect(configBase.glow).toEqual({
      reach_scale: 1.5,
      plateau_share: 0.55,
      disc_opacity: 0.3,
      small_hold_max_boost: 1,
      spread_fraction: 0.91,
      merge_softness: 0.6,
      seam_blend_fraction: 0.9,
      seam_sharpness: 3,
      fringe_deepen: 0.4,
    });
    expect(configBase.fill).toEqual({ opacity: 0.8 });
    expect(configBase.mark_style).toBe('fill');
    expect(configBase.glyphs).toBe('role');
    expect('led_cover' in configBase).toBe(false);
  });

  it('reaches 20% further on Woods, and nowhere else (issue #4971)', () => {
    // A Woods placement radius is ~1.1-1.6% of its board's width where an
    // Aurora one is ~2.8%, and the glow's reach is measured off that radius, so
    // the same tuning reads much smaller on this board. The correction is a
    // board-level multiplier in `@boardsesh/board-look`, so the app and a
    // server render of the same climb send the same number.
    getBoardRenderDataMock.mockReturnValue(WOODS_HOLDS);
    const woods = buildConfig(WOODS_8X10, {
      frames: 'p1r2',
      boardsesh: boardseshInputs(),
      renderSignature: 'woods-reach',
    });
    expect(woods.glow).toEqual({
      reach_scale: 1.2,
      plateau_share: 0.4,
      disc_opacity: 0,
      small_hold_max_boost: 1.7,
      spread_fraction: 0.91,
      merge_softness: 0.6,
      seam_blend_fraction: 0.9,
      seam_sharpness: 3,
      fringe_deepen: 0.4,
    });

    // Every other board keeps the shipped reach, and the rest of the Woods
    // drawing — curve, brightness, fill, mark — is what it always was.
    getBoardRenderDataMock.mockReturnValue(GRASSHOPPER_HOLDS);
    const grasshopper = buildConfig(GRASSHOPPER, {
      frames: GRASSHOPPER_FRAMES,
      boardsesh: boardseshInputs(),
      renderSignature: 'grasshopper-reach',
    });
    expect(asRecord(grasshopper.glow).reach_scale).toBe(1);
    expect(woods.glow).toEqual({ ...asRecord(grasshopper.glow), reach_scale: 1.2 });
    expect(woods.glow_falloff).toBe(grasshopper.glow_falloff);
    expect(woods.mark_style).toBe(grasshopper.mark_style);
    expect(woods.fill).toEqual(grasshopper.fill);
  });

  it('multiplies the Glow reach a Woods climber saved rather than replacing it', () => {
    // The slider still means what it says on Woods: the board correction rides
    // on top of the stored setting, which is untouched by any of this.
    getBoardRenderDataMock.mockReturnValue(WOODS_HOLDS);
    const configBase = buildConfig(WOODS_8X10, {
      frames: 'p1r2',
      boardsesh: boardseshInputs({ glowReach: 1.5 }),
      renderSignature: 'woods-reach-slider',
    });
    expect(asRecord(configBase.glow).reach_scale).toBeCloseTo(1.8, 10);
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

  it('repaints the dark-blue HAND to the Aura cyan, and still lets the climber overrule it', () => {
    getBoardRenderDataMock.mockReturnValue(TENSION_HOLDS);

    const auraConfig = buildConfig(TB2_MIRROR, {
      frames: 'p304r2',
      boardsesh: boardseshInputs(),
      renderSignature: 'boardsesh-hand',
    });
    expect(stateInfoByColorRole(auraConfig, 2)?.color).toBe('#4DF5FD');

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

  it('withholds every outline for Modern Classic, and keeps the veil and LED covers', () => {
    // This IS the Modern Classic drawing: with no outline the renderer falls
    // back to the placement circle, so the veil punches circles and the glow
    // follows them. `led_inner` and `silhouette_lightness` go with the
    // silhouette they were traced and measured against; the veil and the LED
    // covers never read an outline and must survive.
    const configBase = buildConfig(GRASSHOPPER, {
      frames: GRASSHOPPER_FRAMES,
      boardsesh: boardseshInputs({ holdShape: 'circle' }),
      renderSignature: 'modern-classic-geometry',
    });

    const litHold = holdById(configBase, 1);
    expect('outline' in litHold).toBe(false);
    expect('led_inner' in litHold).toBe(false);
    expect('silhouette_lightness' in litHold).toBe(false);
    // The LED cover rides the placement, not the silhouette — Grasshopper's art
    // paints those pips bright whether or not anything is traced over them.
    expect(Array.isArray(litHold.led)).toBe(true);
    expect(asRecord(configBase.veil).opacity).toBeCloseTo(0.6);
    expect(configBase.led_cover).toBeDefined();
  });

  it('aura ships its tuning on full renders but never on thumbnails, and no spill outlines', () => {
    const fullConfig = buildConfig(GRASSHOPPER, {
      frames: GRASSHOPPER_FRAMES,
      boardsesh: boardseshInputs(),
      renderSignature: 'boardsesh-aura-full',
    });
    // The default style is Boardsesh Aura: the bundle rides the full render…
    const glow = asRecord(fullConfig.glow);
    expect(glow.spread_fraction).toBeCloseTo(0.91);
    expect(glow.merge_softness).toBeCloseTo(0.6);
    expect(glow.seam_sharpness).toBeCloseTo(3);
    // …but Aura carries no spill, so no unlit hold gets an outline (placement
    // 2 is well inside what would be spill range).
    expect('outline' in holdById(fullConfig, 2)).toBe(false);

    // Thumbnails skip the bundle: invisible at 200px, ~2.5x the render.
    const thumbConfig = buildConfig(GRASSHOPPER, {
      filledStyle: true,
      frames: GRASSHOPPER_FRAMES,
      boardsesh: boardseshInputs(),
      renderSignature: 'boardsesh-aura-thumb',
    });
    expect('spread_fraction' in asRecord(thumbConfig.glow)).toBe(false);
    expect('merge_softness' in asRecord(thumbConfig.glow)).toBe(false);
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
});

describe('per-hold geometry, joined against the real shard data', () => {
  // Every case above proves withLitHoldGeometry's `geometry.outlines[hold.id]`
  // lookup against hand-picked mock holds, mocked through `getBoardRenderData`.
  // Both the mock ids and the shard's ids come from fixtures written for this
  // file, so a mismatch between the two REAL catalogues — the placement ids
  // `@boardsesh/board-constants` hands out and the ids
  // `@boardsesh/board-art-geometry` traced outlines against — would still
  // pass. This proves the same lookup with the real `getBoardRenderData` and
  // the real shards.
  //
  // Tension Board 2 Mirror 12x12 (tension, layout 10, size 6 — the same
  // `TB2_MIRROR` fixture the veil tests below use) is fully traced today
  // (498/498, per the generated `outline-counts` table), so any two of its
  // real placement ids are traced ones. Kilter's `1-10` (12x12 with
  // kickboard) is fully traced too (476/476) — the real board with untraced
  // placements today is Kilter's `1-7` (12 x 14, Commercial: 476/527, 51
  // untraced), so that shard stands in for the "lit but untraced" case.
  // `TB2_MIRROR.setIds` ('20') is only ever fed to the MOCKED
  // `getBoardRenderData` elsewhere in this file, so it was never checked
  // against a real set for this layout+size — set 12 is ('10-6-12' in the
  // generated product-sizes table).
  const TB2_MIRROR_REAL_SET_IDS = '12';
  const KILTER_UNTRACED = { boardName: 'kilter' as const, layoutId: 1, sizeId: 7, setIds: '1,20' };

  // The board-details module is mocked at the top of this file, so
  // `_getBoardConfigForTests` never reaches the real `getBoardRenderData`
  // unless the mock is told to hand it back. `vi.importActual` gets the real
  // implementation past that mock for these two cases only; loading it once
  // up front and pinning it with `mockReturnValue` (rather than delegating
  // through `mockImplementation`, whose declared type here is the zero-arg
  // canned-fixture shape every other case in this file uses) sidesteps that
  // mismatch entirely, since a fixed return value never needs a matching
  // parameter list.
  async function loadRealRenderData(query: {
    boardName: 'tension' | 'kilter' | 'woods';
    layoutId: number;
    sizeId: number;
    setIds: number[];
  }): Promise<{ holdsData: { id: number }[] }> {
    const actual = await vi.importActual<typeof import('../../lib/board-details')>('../../lib/board-details');
    const renderData = actual.getBoardRenderData(query);
    if (renderData === null) throw new Error(`no real render data for ${JSON.stringify(query)}`);
    getBoardRenderDataMock.mockReturnValue(renderData);
    return renderData;
  }

  function expectRealOutline(litHold: Record<string, unknown>): void {
    expect(Array.isArray(litHold.outline)).toBe(true);
    const outline = litHold.outline as number[];
    expect(outline.length % 2).toBe(0);
    expect(outline.length).toBeGreaterThanOrEqual(6);
    expect(outline.every((coordinate) => Number.isFinite(coordinate))).toBe(true);
  }

  it('attaches the real traced outline on Tension Board 2 Mirror 12x12, and nothing on an unlit hold', async () => {
    const geometry = loadBoardArtGeometry(TB2_MIRROR);
    expect(geometry).not.toBeNull();

    const { holdsData } = await loadRealRenderData({
      boardName: TB2_MIRROR.boardName,
      layoutId: TB2_MIRROR.layoutId,
      sizeId: TB2_MIRROR.sizeId,
      setIds: [Number(TB2_MIRROR_REAL_SET_IDS)],
    });
    expect(holdsData.length).toBeGreaterThan(2);

    // Fully traced (498/498): any two real ids are traced ones.
    const [litA, litB, unlit] = holdsData;
    expect(geometry?.outlines[litA.id]).toBeDefined();
    expect(geometry?.outlines[litB.id]).toBeDefined();

    const configBase = buildConfig(
      { ...TB2_MIRROR, setIds: TB2_MIRROR_REAL_SET_IDS },
      {
        frames: `p${litA.id}r2p${litB.id}r2`,
        boardsesh: boardseshInputs(),
        renderSignature: 'real-shard-tb2-mirror',
      },
    );

    expectRealOutline(holdById(configBase, litA.id));
    expectRealOutline(holdById(configBase, litB.id));
    // A real placement this climb does not light gets no outline at all.
    expect('outline' in holdById(configBase, unlit.id)).toBe(false);
  });

  it('leaves a real untraced Kilter placement without an outline, even when it is lit', async () => {
    const geometry = loadBoardArtGeometry(KILTER_UNTRACED);
    expect(geometry).not.toBeNull();

    const { holdsData } = await loadRealRenderData({
      boardName: KILTER_UNTRACED.boardName,
      layoutId: KILTER_UNTRACED.layoutId,
      sizeId: KILTER_UNTRACED.sizeId,
      setIds: [1, 20],
    });

    const traced = holdsData.filter((hold) => geometry?.outlines[hold.id] !== undefined);
    const untracedHold = holdsData.find((hold) => geometry?.outlines[hold.id] === undefined);
    expect(traced.length).toBeGreaterThanOrEqual(2);
    // The 51 untraced placements gate-4 pins for this shard (527 - 476): at
    // least one real id the tracer skipped.
    expect(untracedHold).toBeDefined();
    const untracedId = (untracedHold as { id: number }).id;

    const [tracedA, tracedB] = traced;
    const configBase = buildConfig(KILTER_UNTRACED, {
      frames: `p${tracedA.id}r43p${tracedB.id}r43p${untracedId}r43`,
      boardsesh: boardseshInputs(),
      renderSignature: 'real-shard-kilter-untraced',
    });

    expectRealOutline(holdById(configBase, tracedA.id));
    expectRealOutline(holdById(configBase, tracedB.id));
    // Lit, but no traced art: the renderer's own ring fallback, not a
    // fabricated outline.
    expect('outline' in holdById(configBase, untracedId)).toBe(false);
  });

  it('attaches the real traced outline on Woods, whose substance is keyed off a white ground', async () => {
    // Woods is the one board whose art is a photograph rather than a stack of
    // transparent layers, so it shipped NO shard until the tracer learned to key
    // its white sweep away — this case asserted "no outlines at all" up to that
    // point. It is the only config family on the white-key path, and the whole
    // point of the path is that nothing downstream can tell: the hook does the
    // same `geometry.outlines[hold.id]` lookup it does for a sprite sheet.
    const geometry = loadBoardArtGeometry(WOODS_8X10);
    expect(geometry).not.toBeNull();
    // All 379 physical holds have outlines; 106 empty logical slots do not.
    expect(Object.keys(geometry?.outlines ?? {}).length).toBe(379);

    const { holdsData } = await loadRealRenderData({
      boardName: WOODS_8X10.boardName,
      layoutId: WOODS_8X10.layoutId,
      sizeId: WOODS_8X10.sizeId,
      setIds: [Number(WOODS_8X10.setIds)],
    });
    const traced = holdsData.filter((hold) => geometry?.outlines[hold.id] !== undefined);
    const untracedHold = holdsData.find((hold) => geometry?.outlines[hold.id] === undefined);
    expect(traced.length).toBeGreaterThanOrEqual(2);
    expect(untracedHold).toBeDefined();
    const untracedId = (untracedHold as { id: number }).id;

    const [tracedA, tracedB] = traced;
    const configBase = buildConfig(WOODS_8X10, {
      frames: `p${tracedA.id}r2p${tracedB.id}r2p${untracedId}r2`,
      boardsesh: boardseshInputs(),
      renderSignature: 'real-shard-woods',
    });

    expect(configBase.render_mode).toBe('aura');
    expectRealOutline(holdById(configBase, tracedA.id));
    expectRealOutline(holdById(configBase, tracedB.id));
    // A bolt on bare sweep still falls back to a ring, the same contract
    // MoonBoard's empty grid cells already use.
    expect('outline' in holdById(configBase, untracedId)).toBe(false);
    // Woods' art paints no bright LED — its `ledBright` table is empty — so
    // there is nothing for the renderer to cover.
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

  it('washes Woods softly, off a wall reading taken after its white ground was keyed away', () => {
    // Woods had NO row here at all while it shipped no shard, and the veil was
    // simply off. The rows exist now, and they are the keyed readings: measured
    // with the photograph's own alpha the white sweep between holds reads 0.743
    // and 0.766 at 100% coverage, which is the ground rather than the wall.
    expect(getWallLightness(WOODS_8X10)).toEqual({ mean: 0.511, coverage: 0.893 });
    expect(getWallLightness({ boardName: 'woods', layoutId: 1, sizeId: 2 })).toEqual({
      mean: 0.522,
      coverage: 0.965,
    });

    expect(resolveVeilOpacity(DEFAULT_BOARDSESH_RENDER_SETTINGS, getWallLightness(WOODS_8X10), DARK_FIELD)).toBe(0.3);
    // Both calibrated boards remain in the soft-wash bucket.
    expect(
      resolveVeilOpacity(
        DEFAULT_BOARDSESH_RENDER_SETTINGS,
        getWallLightness({ boardName: 'woods', layoutId: 1, sizeId: 2 }),
        DARK_FIELD,
      ),
    ).toBe(0.3);
  });
});

describe('the cache key', () => {
  const CLIMB = { boardName: 'grasshopper', layoutId: 1, sizeId: 5, setIds: '1' };

  function keyFor(boardSignature: string, frames: string = GRASSHOPPER_FRAMES): string {
    const composed = ['default', boardSignature].filter(Boolean).join('.');
    return buildCacheKey(
      CLIMB.boardName,
      CLIMB.layoutId,
      CLIMB.sizeId,
      CLIMB.setIds,
      frames,
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
        { mode: 'aura', boardsesh: { ...DEFAULT_BOARDSESH_RENDER_SETTINGS, ...overrides } },
        true,
      ),
      fieldColor,
      veilOpacity,
    );
  }

  it('carries the current renderer version and is otherwise the classic key', () => {
    const classicKey = keyFor('');
    expect(classicKey).toMatch(/^v16_/);
    expect(classicKey).toBe(
      buildCacheKey(CLIMB.boardName, CLIMB.layoutId, CLIMB.sizeId, CLIMB.setIds, GRASSHOPPER_FRAMES),
    );
  });

  it('separates a Boardsesh render from the classic one', () => {
    expect(keyFor(signatureFor({}))).not.toBe(keyFor(''));
  });

  /**
   * One non-default value per `BoardseshRenderSettings` field, keyed by the
   * type itself — a 13th field is a compile error here until it is listed, so
   * the it.each below (driven off `DEFAULT_BOARDSESH_RENDER_SETTINGS`'s own
   * keys) can never silently skip a token that should split the cache.
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

  /**
   * `veilOpacity` only reaches `resolveVeilOpacity` when `veil` is `'custom'`
   * — paired here so moving this field alone actually changes the resolved
   * opacity, rather than silently doing nothing under the still-`'auto'`
   * default the raw override would otherwise leave in place.
   */
  function overrideFor(field: keyof BoardseshRenderSettings): Partial<BoardseshRenderSettings> {
    if (field === 'veilOpacity') return { veil: 'custom', veilOpacity: MOVED_OFF_DEFAULT.veilOpacity };
    return { [field]: MOVED_OFF_DEFAULT[field] } as Partial<BoardseshRenderSettings>;
  }

  // Gap to the dark field lands in the soft bucket (0.175-0.34), so `auto`
  // resolves to 0.3 here — different from both `strong` (always 0.6) and a
  // `custom` 0.5, which is what lets `veil` and `veilOpacity` prove they move
  // the key too, resolved the way the hook resolves them rather than as a raw,
  // unresolved override.
  const WALL_ROW = { mean: 0.45, coverage: 1 };

  function resolvedSignatureFor(overrides: Partial<BoardseshRenderSettings>): string {
    const boardsesh = { ...DEFAULT_BOARDSESH_RENDER_SETTINGS, ...overrides };
    const effective = resolveEffectiveRenderSettings({ mode: 'aura', boardsesh }, true);
    const veilOpacity = resolveVeilOpacity(boardsesh, WALL_ROW, DARK_FIELD);
    return buildBoardRenderSignature(effective, DARK_FIELD, veilOpacity);
  }

  it.each(Object.keys(DEFAULT_BOARDSESH_RENDER_SETTINGS) as (keyof BoardseshRenderSettings)[])(
    'changes when %s changes',
    (field) => {
      expect(keyFor(resolvedSignatureFor(overrideFor(field)))).not.toBe(keyFor(resolvedSignatureFor({})));
    },
  );

  it('changes when the theme flips the play field under the veil', () => {
    // Both halves of the flip move: the field colour the veil washes toward,
    // and the strength the measurement gives it on that field.
    expect(keyFor(signatureFor({}, LIGHT_FIELD, 0))).not.toBe(keyFor(signatureFor({}, DARK_FIELD, 0.6)));
  });

  it('keeps the Boardsesh half of the key alive across an empty-frames render', () => {
    // No frames means nothing to colour- or shape-override, but a Boardsesh
    // render with zero frames still paints the veil and the field wash — the
    // key must still tell the two themes apart, not collapse to one classic
    // key the way it used to.
    const lightKey = keyFor(signatureFor({}, LIGHT_FIELD, 0), '');
    const darkKey = keyFor(signatureFor({}, DARK_FIELD, 0.6), '');
    expect(lightKey).not.toBe(darkKey);
  });

  it('still collapses a classic render with empty frames to the default key', () => {
    // Unchanged from before the fix: with no frames, there is nothing lit for
    // a marker override to apply to, so a classic signature (no
    // `mode-boardsesh` token at all) still ignores it.
    expect(keyFor('hand-123456', '')).toBe(keyFor('', ''));
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
    boardRenderSettingsRef.current = { ...DEFAULT_BOARD_RENDER_SETTINGS, mode: 'aura' };
  });

  it('never asks an unverified library for the mode, then switches once the probe says yes', async () => {
    const { result } = renderHook(() =>
      useNativeClimbRender({ ...GRASSHOPPER, frames: GRASSHOPPER_FRAMES, boardName: 'grasshopper' }),
    );

    // The first render goes out before the probe answers, and it is classic:
    // RenderConfig has no `deny_unknown_fields`, so a stale library would have
    // accepted a Boardsesh config, ignored it, and said nothing.
    expect(sentConfigs()[0]?.render_mode).toBeUndefined();

    await waitFor(() => expect(sentConfigs().some((config) => config.render_mode === 'aura')).toBe(true));
    expect(result.current.boardseshRendererAvailable).toBe(true);
    expect(result.current.effectiveRenderSettings.mode).toBe('aura');
  });

  it('bakes the theme’s field and the board’s measured wash into the config', async () => {
    renderHook(() => useNativeClimbRender({ ...GRASSHOPPER, frames: GRASSHOPPER_FRAMES, boardName: 'grasshopper' }));

    await waitFor(() => expect(sentConfigs().some((config) => config.render_mode === 'aura')).toBe(true));
    const auraConfig = sentConfigs().find((config) => config.render_mode === 'aura');
    // Grasshopper's wall sits close enough to the dark field for the soft wash.
    expect(auraConfig?.veil).toEqual({ color: DARK_FIELD, opacity: 0.3 });
  });

  // Editing surfaces (the create board) draw no wash at all: the wall behind a
  // lit hold is scenery in the play view, but in the editor the next hold to
  // find and tap is one of the UNLIT ones, so any wash works against the screen.
  // Aura's glow already separates what is lit.
  it('draws no veil at all on an editing surface, even on the strongest-wash board', async () => {
    getBoardRenderDataMock.mockReturnValue(TENSION_HOLDS);

    renderHook(() =>
      useNativeClimbRender({ ...TENSION_ORIGINAL, frames: 'p304r2', maxVeilOpacity: EDITING_VEIL_OPACITY }),
    );

    await waitFor(() => expect(sentConfigs().some((config) => config.render_mode === 'aura')).toBe(true));
    const auraConfig = sentConfigs().find((config) => config.render_mode === 'aura');
    // Unveiled this board resolves to the strong 0.6 bucket — the worst case the
    // editor has to survive.
    expect(resolveVeilOpacity(DEFAULT_BOARDSESH_RENDER_SETTINGS, getWallLightness(TENSION_ORIGINAL), DARK_FIELD)).toBe(
      0.6,
    );
    // A zero-opacity wash is not sent as a wash: the key is dropped entirely.
    expect(auraConfig && 'veil' in auraConfig).toBe(false);
  });

  it('gives the unveiled render its own cache key, so it cannot be served the washed PNG', async () => {
    getBoardRenderDataMock.mockReturnValue(TENSION_HOLDS);

    const veiled = renderHook(() => useNativeClimbRender({ ...TENSION_ORIGINAL, frames: 'p304r2' }));
    await waitFor(() => expect(sentConfigs().some((config) => config.render_mode === 'aura')).toBe(true));
    const veiledKeys = nativeModule.renderHoldsOverlay.mock.calls.map(([, cacheKey]) => cacheKey);
    veiled.unmount();

    renderHook(() =>
      useNativeClimbRender({ ...TENSION_ORIGINAL, frames: 'p304r2', maxVeilOpacity: EDITING_VEIL_OPACITY }),
    );
    await waitFor(() =>
      expect(nativeModule.renderHoldsOverlay.mock.calls.some(([, cacheKey]) => !veiledKeys.includes(cacheKey))).toBe(
        true,
      ),
    );
  });

  it('leaves a board whose veil is already off on the shared cache key', async () => {
    // In light mode the wall is not fighting a dark field, so the measurement
    // turns the veil off on its own and the ceiling cannot bind. The editing
    // surface must land on the SAME key the play view already uses rather than
    // forking the cache for a byte-identical PNG — which shows up as the second
    // hook issuing no render at all.
    appColorScheme.current = 'light';

    renderHook(() => useNativeClimbRender({ ...GRASSHOPPER, frames: GRASSHOPPER_FRAMES, boardName: 'grasshopper' }));
    await waitFor(() => expect(sentConfigs().some((config) => config.render_mode === 'aura')).toBe(true));
    const auraConfig = sentConfigs().find((config) => config.render_mode === 'aura');
    expect(auraConfig && 'veil' in auraConfig).toBe(false);

    nativeModule.renderHoldsOverlay.mockClear();
    const { result } = renderHook(() =>
      useNativeClimbRender({
        ...GRASSHOPPER,
        frames: GRASSHOPPER_FRAMES,
        boardName: 'grasshopper',
        maxVeilOpacity: EDITING_VEIL_OPACITY,
      }),
    );

    await waitFor(() => expect(result.current.overlayUri).toBe('file:///overlay.png'));
    expect(nativeModule.renderHoldsOverlay).not.toHaveBeenCalled();
  });

  // The PNG player board fades its climbs over a bare wall (png-swap-layers.ts):
  // the same photo with the veil and LED covers and no climb on it. The renderer
  // draws exactly that for empty frames; every other surface renders nothing.
  it('renders the bare wall for empty frames only when asked, with the veil and LED covers', async () => {
    const plain = renderHook(() => useNativeClimbRender({ ...GRASSHOPPER, frames: '' }));
    await act(async () => {});
    expect(nativeModule.renderHoldsOverlay).not.toHaveBeenCalled();
    expect(plain.result.current.overlayUri).toBeNull();
    plain.unmount();

    const { result } = renderHook(() => useNativeClimbRender({ ...GRASSHOPPER, frames: '', bareWall: true }));
    await waitFor(() => expect(sentConfigs().some((config) => config.render_mode === 'aura')).toBe(true));
    const bareWall = sentConfigs().find((config) => config.render_mode === 'aura');
    expect(bareWall?.frames).toBe('');
    expect(bareWall?.veil).toEqual({ color: DARK_FIELD, opacity: 0.3 });
    expect(bareWall?.led_cover).toBeDefined();
    await waitFor(() => expect(result.current.overlayUri).toBe('file:///overlay.png'));
    expect(result.current.overlayUnavailable).toBe(false);
    // Nothing lit, so nothing for the hold-match guard to judge or skip.
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining('no matching holds'));

    // Its own key: the veil's half of the signature, no climb's frames.
    const [, bareWallKey] = nativeModule.renderHoldsOverlay.mock.calls.at(-1)!;
    expect(result.current.overlayCacheKey).toBe(bareWallKey);
    const climb = renderHook(() =>
      useNativeClimbRender({ ...GRASSHOPPER, frames: GRASSHOPPER_FRAMES, boardName: 'grasshopper' }),
    );
    expect(climb.result.current.overlayCacheKey).not.toBe(bareWallKey);
  });

  it('does not call the renderer missing while a render is merely still running', async () => {
    // The create board draws its own holds when there is no renderer at all. If
    // "no overlay yet" read as "no renderer", it would flash those JS-drawn holds
    // before the real ones on every cold render on a perfectly capable device.
    const { result } = renderHook(() =>
      useNativeClimbRender({ ...GRASSHOPPER, frames: GRASSHOPPER_FRAMES, boardName: 'grasshopper' }),
    );

    expect(result.current.overlayUri).toBeNull();
    expect(result.current.rendererUnavailable).toBe(false);

    await waitFor(() => expect(result.current.overlayUri).toBe('file:///overlay.png'));
    expect(result.current.rendererUnavailable).toBe(false);
  });

  it('spends the module-load budget on its own schedule, with no render to ride on', async () => {
    // Expo Go and a dev client without the binary: the loader retries per call
    // and only gives up after its budget. Nothing else in the hook re-renders
    // while there is no overlay, so a create board opened on an existing climb
    // and left alone would never spend the rest of that budget — and the
    // JS-drawn holds gated on the give-up would stay invisible all session.
    _resetNativeModuleLoadForTests();

    const { result, rerender } = renderHook(() =>
      useNativeClimbRender({ ...GRASSHOPPER, frames: GRASSHOPPER_FRAMES, boardName: 'grasshopper' }),
    );

    // The first attempt is spent, the budget is not: "not yet", not "never".
    expect(result.current.rendererUnavailable).toBe(false);

    // No prop moves and no render resolves between here and the give-up — the
    // hook has to schedule the remaining attempts itself.
    await waitFor(() => expect(result.current.rendererUnavailable).toBe(true), { timeout: 3000 });
    expect(result.current.overlayUri).toBeNull();

    rerender();
    expect(result.current.rendererUnavailable).toBe(true);
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
      if ((JSON.parse(configJson) as { render_mode?: string }).render_mode === 'aura') {
        throw new Error(_BOARDSESH_RENDERER_UNAVAILABLE_MESSAGE_FOR_TESTS);
      }
      return 'file:///overlay-classic.png';
    });

    const { result } = renderHook(() =>
      useNativeClimbRender({ ...GRASSHOPPER, frames: GRASSHOPPER_FRAMES, boardName: 'grasshopper' }),
    );

    await waitFor(() => expect(sentConfigs().some((config) => config.render_mode === 'aura')).toBe(true));
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

// The hold heatmap draws its buckets as synthetic codes (900–904) filled into
// each hold's silhouette, through the same hook every board surface uses.
describe('useNativeClimbRender heatmap seams', () => {
  const nativeModule = {
    boardRendererNative: {},
    renderHoldsOverlay: vi.fn<(configJson: string, cacheKey: string) => Promise<string>>(),
    probeBoardseshRendererSupport: vi.fn<() => Promise<boolean>>(),
  };
  const HEAT_STATES = { 900: { color: '#4C1D95' }, 904: { color: '#F5F3FF' } } as const;
  const OTHER_HEAT_STATES = { 900: { color: '#DDD6FE' }, 904: { color: '#2E1065' } } as const;
  const HEAT_FRAMES = 'p1r900p2r904';

  function sentConfigs(): Record<string, unknown>[] {
    return nativeModule.renderHoldsOverlay.mock.calls.map(([configJson]) => JSON.parse(configJson));
  }
  function sentKeys(): string[] {
    return nativeModule.renderHoldsOverlay.mock.calls.map(([, cacheKey]) => cacheKey);
  }

  beforeEach(() => {
    nativeModule.renderHoldsOverlay.mockReset();
    nativeModule.renderHoldsOverlay.mockResolvedValue('file:///overlay.png');
    nativeModule.probeBoardseshRendererSupport.mockReset();
    nativeModule.probeBoardseshRendererSupport.mockResolvedValue(true);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    _setNativeModuleForTests(nativeModule as unknown as Parameters<typeof _setNativeModuleForTests>[0]);
    // A climber who picked the classic drawing: the override still asks for Aura.
    boardRenderSettingsRef.current = { ...DEFAULT_BOARD_RENDER_SETTINGS, mode: 'classic' };
  });

  it('merges the extra hold states over the board map and fills the marks', async () => {
    renderHook(() =>
      useNativeClimbRender({
        ...GRASSHOPPER,
        frames: HEAT_FRAMES,
        extraHoldStates: HEAT_STATES,
        markStyleOverride: 'fill',
        maxVeilOpacity: EDITING_VEIL_OPACITY,
      }),
    );

    await waitFor(() => expect(sentConfigs().some((config) => config.render_mode === 'aura')).toBe(true));
    const auraConfig = sentConfigs().find((config) => config.render_mode === 'aura');
    expect(auraConfig?.mark_style).toBe('fill');
    const holdStateMap = asRecord(auraConfig?.hold_state_map);
    expect(holdStateMap[900]).toEqual({ color: '#4C1D95' });
    expect(holdStateMap[904]).toEqual({ color: '#F5F3FF' });
    // The board's own roles are still there, untouched.
    expect(holdStateMap[2]).toBeDefined();
    // No wash on the heat layer: the photo under it has to stay readable.
    expect(auraConfig && 'veil' in auraConfig).toBe(false);
  });

  it('keys the PNG on the extra states, so a scheme flip cannot reuse the other ramp', async () => {
    const first = renderHook(() =>
      useNativeClimbRender({
        ...GRASSHOPPER,
        frames: HEAT_FRAMES,
        extraHoldStates: HEAT_STATES,
        markStyleOverride: 'fill',
      }),
    );
    await waitFor(() => expect(sentConfigs().some((config) => config.render_mode === 'aura')).toBe(true));
    const firstKeys = sentKeys();
    first.unmount();

    renderHook(() =>
      useNativeClimbRender({
        ...GRASSHOPPER,
        frames: HEAT_FRAMES,
        extraHoldStates: OTHER_HEAT_STATES,
        markStyleOverride: 'fill',
      }),
    );
    await waitFor(() => expect(sentKeys().some((cacheKey) => !firstKeys.includes(cacheKey))).toBe(true));
  });

  it('builds a different config-cache entry for different extras on the same board', () => {
    const inputs = boardseshInputs({ markStyle: 'fill' });
    const withHeat = _getBoardConfigForTests(
      'grasshopper',
      1,
      5,
      '1',
      false,
      undefined,
      {},
      {},
      1,
      1,
      'default.xs-a',
      inputs,
      HEAT_FRAMES,
      HEAT_STATES,
    );
    const plain = _getBoardConfigForTests('grasshopper', 1, 5, '1', false, undefined, {}, {}, 1, 1, 'default', inputs);
    expect(asRecord(asRecord(withHeat?.configBase).hold_state_map)[900]).toEqual({ color: '#4C1D95' });
    expect(asRecord(asRecord(plain?.configBase).hold_state_map)[900]).toBeUndefined();
  });

  it('leaves every other surface byte-identical: no extras, no override → same config and key', async () => {
    boardRenderSettingsRef.current = { ...DEFAULT_BOARD_RENDER_SETTINGS, mode: 'aura' };
    const plain = renderHook(() => useNativeClimbRender({ ...GRASSHOPPER, frames: GRASSHOPPER_FRAMES }));
    await waitFor(() => expect(sentConfigs().some((config) => config.render_mode === 'aura')).toBe(true));
    const plainCalls = nativeModule.renderHoldsOverlay.mock.calls.map(([json, key]) => [json, key]);
    plain.unmount();
    _renderedOverlaysForTests.clear();
    _inflightRendersForTests.clear();
    nativeModule.renderHoldsOverlay.mockClear();

    renderHook(() =>
      useNativeClimbRender({
        ...GRASSHOPPER,
        frames: GRASSHOPPER_FRAMES,
        extraHoldStates: undefined,
        markStyleOverride: undefined,
      }),
    );
    await waitFor(() => expect(sentConfigs().some((config) => config.render_mode === 'aura')).toBe(true));
    const explicitCalls = nativeModule.renderHoldsOverlay.mock.calls.map(([json, key]) => [json, key]);
    // Same config JSON, byte for byte, under the same cache key.
    expect(explicitCalls.at(-1)).toEqual(plainCalls.at(-1));
    const [, cacheKey] = plainCalls.at(-1) ?? [];
    expect(cacheKey).toBeDefined();
    const auraConfig = sentConfigs().find((config) => config.render_mode === 'aura');
    expect(auraConfig?.mark_style).toBe('glow');
    expect(Object.keys(asRecord(auraConfig?.hold_state_map)).some((code) => Number(code) >= 900)).toBe(false);

    // And the config builder hands back the cached board config untouched.
    const inputs = boardseshInputs();
    const withoutArg = _getBoardConfigForTests(
      'grasshopper',
      1,
      5,
      '1',
      false,
      undefined,
      {},
      {},
      1,
      1,
      'default',
      inputs,
    );
    const withUndefined = _getBoardConfigForTests(
      'grasshopper',
      1,
      5,
      '1',
      false,
      undefined,
      {},
      {},
      1,
      1,
      'default',
      inputs,
      '',
      undefined,
    );
    expect(JSON.stringify(withUndefined?.configBase)).toBe(JSON.stringify(withoutArg?.configBase));
  });

  it('keys the heat PNG on the extras without splitting the board-config cache', () => {
    // The extras are merged over the cached entry on the way out, so the same
    // board config serves every heat map.
    const inputs = boardseshInputs({ markStyle: 'fill' });
    const first = _getBoardConfigForTests(
      'grasshopper',
      1,
      5,
      '1',
      false,
      undefined,
      {},
      {},
      1,
      1,
      'sig',
      inputs,
      '',
      HEAT_STATES,
    );
    const second = _getBoardConfigForTests(
      'grasshopper',
      1,
      5,
      '1',
      false,
      undefined,
      {},
      {},
      1,
      1,
      'sig',
      inputs,
      '',
      OTHER_HEAT_STATES,
    );
    expect(asRecord(asRecord(first?.configBase).hold_state_map)[900]).toEqual({ color: '#4C1D95' });
    expect(asRecord(asRecord(second?.configBase).hold_state_map)[900]).toEqual({ color: '#DDD6FE' });
    expect(asRecord(first?.configBase).holds).toBe(asRecord(second?.configBase).holds);
  });

  it('stays classic, and says so, when the binary cannot draw the fill', async () => {
    nativeModule.probeBoardseshRendererSupport.mockResolvedValue(false);
    const { result } = renderHook(() =>
      useNativeClimbRender({
        ...GRASSHOPPER,
        frames: HEAT_FRAMES,
        extraHoldStates: HEAT_STATES,
        markStyleOverride: 'fill',
      }),
    );
    await waitFor(() => expect(result.current.boardseshRendererAvailable).toBe(false));
    expect(sentConfigs().every((config) => config.render_mode === undefined)).toBe(true);
  });
});

describe('live Homewall GPU render selection', () => {
  const board = {
    boardName: 'kilter' as const,
    layoutId: 8,
    sizeId: 25,
    setIds: '26,27,28,29',
    gpuSurface: true,
    gpuApiVersion: 3,
    playSurface: true,
  };
  const nativeModule = {
    boardRendererNative: {},
    renderHoldsOverlay: vi.fn<(config: string, key: string) => Promise<string>>(),
    probeBoardseshRendererSupport: vi.fn<() => Promise<boolean>>(),
  };
  beforeEach(() => {
    nativeModule.renderHoldsOverlay.mockReset().mockResolvedValue('file:///gpu-fallback.png');
    nativeModule.probeBoardseshRendererSupport.mockReset().mockResolvedValue(true);
    _setNativeModuleForTests(nativeModule as unknown as Parameters<typeof _setNativeModuleForTests>[0]);
    boardRenderSettingsRef.current = { ...DEFAULT_BOARD_RENDER_SETTINGS, mode: 'aura' };
    getBoardRenderDataMock.mockReturnValue({
      boardWidth: 1080,
      boardHeight: 1504,
      holdsData: [4131, 4306].map((id) => ({ id, mirroredHoldId: null, cx: 100, cy: 200, r: 20 })),
    });
  });

  it('uses the host ground for GPU and PNG fallback, and invalidates opening artwork on a surface change', async () => {
    const { result, rerender } = renderHook(
      ({ fieldColorOverride, fallback, hedge }) =>
        useNativeClimbRender({
          ...board,
          frames: 'p4131r42',
          fieldColorOverride,
          gpuFallbackConfigJson: fallback,
          gpuHedgeCacheKey: hedge,
        }),
      {
        initialProps: {
          fieldColorOverride: '#1C1C1E' as string | undefined,
          fallback: null as string | null,
          hedge: null as string | null,
        },
      },
    );
    await waitFor(() => expect(result.current.gpuConfigJson).toBeTruthy());
    expect(nativeModule.renderHoldsOverlay).not.toHaveBeenCalled();
    rerender({ fieldColorOverride: '#1C1C1E', fallback: null, hedge: result.current.overlayCacheKey });
    const firstConfig = result.current.gpuConfigJson!;
    const firstIdentity = result.current.artworkIdentity;
    const firstKey = buildCacheKey(
      board.boardName,
      board.layoutId,
      board.sizeId,
      board.setIds,
      'p4131r42',
      false,
      undefined,
      firstIdentity.renderSignature,
    );
    await waitFor(() => expect(_renderedOverlaysForTests.has(firstKey)).toBe(true));
    expect(JSON.parse(firstConfig).veil.color).toBe('#1C1C1E');
    rerender({ fieldColorOverride: '#15131a', fallback: null, hedge: null });
    await waitFor(() => {
      expect(result.current.gpuStatus).toBe('ready');
      expect(result.current.gpuConfigJson).not.toBe(firstConfig);
    });
    expect(nativeModule.renderHoldsOverlay).toHaveBeenCalledTimes(1);
    rerender({ fieldColorOverride: '#15131a', fallback: null, hedge: result.current.overlayCacheKey });
    const nextConfig = result.current.gpuConfigJson!;
    const nextKey = buildCacheKey(
      board.boardName,
      board.layoutId,
      board.sizeId,
      board.setIds,
      'p4131r42',
      false,
      undefined,
      result.current.artworkIdentity.renderSignature,
    );
    await waitFor(() => expect(_renderedOverlaysForTests.has(nextKey)).toBe(true));
    expect(JSON.parse(nextConfig).veil.color).toBe('#15131a');
    expect(result.current.artworkIdentity.renderSignature).not.toBe(firstIdentity.renderSignature);
    expect(nextKey).not.toBe(firstKey);
    expect(nativeModule.renderHoldsOverlay).toHaveBeenCalledTimes(2);
    const [fallbackConfig, fallbackKey] = nativeModule.renderHoldsOverlay.mock.calls.at(-1)!;
    expect(fallbackKey).toBe(nextKey);
    expect(JSON.parse(fallbackConfig).veil.color).toBe('#15131a');
    rerender({ fieldColorOverride: '#15131a', fallback: nextConfig, hedge: null });
    expect(result.current.gpuConfigJson).toBeNull();
    expect(result.current.overlayUri).toBe(_renderedOverlaysForTests.get(nextKey)?.uri);
    expect(nativeModule.renderHoldsOverlay).toHaveBeenCalledTimes(2);
    rerender({ fieldColorOverride: '#1C1C1E', fallback: nextConfig, hedge: null });
    await waitFor(() => expect(result.current.gpuConfigJson).toBeTruthy());
    const restoredConfig = result.current.gpuConfigJson!;
    rerender({ fieldColorOverride: '#1C1C1E', fallback: restoredConfig, hedge: null });
    expect(result.current.gpuConfigJson).toBeNull();
    expect(result.current.artworkIdentity.renderSignature).toBe(firstIdentity.renderSignature);
    expect(result.current.overlayUri).toBe(_renderedOverlaysForTests.get(firstKey)?.uri);
    expect(nativeModule.renderHoldsOverlay).toHaveBeenCalledTimes(2);
    // A list/editor/share caller without the override keeps its existing palette.
    rerender({ fieldColorOverride: undefined, fallback: null, hedge: null });
    await waitFor(() => expect(result.current.gpuConfigJson).toBeTruthy());
    expect(JSON.parse(result.current.gpuConfigJson!).veil.color).toBe(DARK_FIELD);
  });

  it('invalidates a host-color opening snapshot even when the veil is disabled', async () => {
    const { result, rerender } = renderHook(
      ({ fieldColorOverride }) =>
        useNativeClimbRender({ ...board, frames: 'p4131r42', maxVeilOpacity: 0, fieldColorOverride }),
      { initialProps: { fieldColorOverride: '#1C1C1E' } },
    );
    await waitFor(() => expect(result.current.gpuConfigJson).toBeTruthy());
    const signature = result.current.artworkIdentity.renderSignature;
    expect(JSON.parse(result.current.gpuConfigJson!).veil).toBeUndefined();
    rerender({ fieldColorOverride: '#15131a' });
    expect(result.current.artworkIdentity.renderSignature).not.toBe(signature);
  });

  it('reports loading while native support is being discovered, then ready', async () => {
    let resolveSupport: (supported: boolean) => void = () => {};
    nativeModule.probeBoardseshRendererSupport.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSupport = resolve;
        }),
    );
    const { result, rerender } = renderHook(
      ({ hedge }) => useNativeClimbRender({ ...board, frames: 'p4131r42', gpuHedgeCacheKey: hedge }),
      { initialProps: { hedge: null as string | null } },
    );
    expect(result.current.gpuConfigJson).toBeNull();
    expect(result.current.gpuStatus).toBe('loading');
    act(() => resolveSupport(true));
    await waitFor(() => expect(result.current.gpuStatus).toBe('ready'));
    // GPU first: neither a classic PNG while the probe ran nor an Aura one now.
    expect(nativeModule.renderHoldsOverlay).not.toHaveBeenCalled();
    rerender({ hedge: result.current.overlayCacheKey });
    await waitFor(() => expect(nativeModule.renderHoldsOverlay).toHaveBeenCalledTimes(1));
    expect(JSON.parse(nativeModule.renderHoldsOverlay.mock.calls[0][0])).toMatchObject({
      render_mode: 'aura',
      frames: 'p4131r42',
    });
  });

  it('renders no PNG for a cold GPU attempt until it is hedged, and none after presentation', async () => {
    const { result, rerender } = renderHook(
      ({ frames, presented, hedge }) =>
        useNativeClimbRender({ ...board, frames, gpuPresentedConfigJson: presented, gpuHedgeCacheKey: hedge }),
      {
        initialProps: { frames: 'p4131r42', presented: null as string | null, hedge: null as string | null },
      },
    );
    await waitFor(() => expect(result.current.gpuConfigJson).toBeTruthy());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(nativeModule.renderHoldsOverlay).not.toHaveBeenCalled();
    expect(result.current.overlayUri).toBeNull();
    // A hedge for another climb releases nothing here.
    rerender({ frames: 'p4131r42', presented: null, hedge: 'another-climb' });
    expect(nativeModule.renderHoldsOverlay).not.toHaveBeenCalled();
    rerender({ frames: 'p4131r42', presented: null, hedge: result.current.overlayCacheKey });
    await waitFor(() => expect(result.current.overlayUri).toBe('file:///gpu-fallback.png'));
    const initialConfig = result.current.gpuConfigJson!;
    const parsed = JSON.parse(initialConfig) as {
      holds: Array<{ id: number; outline?: number[] }>;
      frames: string;
      output_width: number;
      hold_state_map: Record<string, unknown>;
    };
    expect(parsed.frames).toBe('');
    expect(parsed.output_width).toBe(1080);
    expect(parsed.holds.every((hold) => hold.outline && hold.outline.length > 0)).toBe(true);
    expect(Object.keys(parsed.hold_state_map)).toEqual(['42', '43', '44', '45']);
    expect(nativeModule.renderHoldsOverlay).toHaveBeenCalledTimes(1);
    expect(JSON.parse(nativeModule.renderHoldsOverlay.mock.calls[0][0])).toMatchObject({
      render_mode: 'aura',
      frames: 'p4131r42',
    });
    const hedged = result.current.overlayCacheKey;
    rerender({ frames: 'p4131r42', presented: initialConfig, hedge: hedged });
    rerender({ frames: 'p4306r43', presented: initialConfig, hedge: hedged });
    expect(result.current.gpuConfigJson).toBe(initialConfig);
    expect(result.current.gpuFrames).toBe('p4306r43');
    expect(nativeModule.renderHoldsOverlay).toHaveBeenCalledTimes(1);
    rerender({ frames: '', presented: initialConfig, hedge: hedged });
    expect(result.current.gpuConfigJson).toBeNull();
    expect(nativeModule.renderHoldsOverlay).toHaveBeenCalledTimes(1);
  });

  it('reuses a presented empty baseline across first-hold v3 editor scenes without PNG work', async () => {
    const { result, rerender } = renderHook(
      ({ frames, presented }) =>
        useNativeClimbRender({
          ...board,
          frames,
          gpuAllowEmpty: true,
          gpuPresentedConfigJson: presented,
          maxVeilOpacity: 0,
        }),
      { initialProps: { frames: '', presented: null as string | null } },
    );
    await waitFor(() => expect(result.current.gpuConfigJson).toBeTruthy());
    const initialConfig = result.current.gpuConfigJson!;
    expect(result.current.gpuFrames).toBe('');
    rerender({ frames: '', presented: initialConfig });
    rerender({ frames: 'p4131r42', presented: initialConfig });
    expect(result.current.gpuConfigJson).toBe(initialConfig);
    rerender({ frames: '', presented: initialConfig });
    expect(result.current.gpuConfigJson).toBe(initialConfig);
    expect(result.current.gpuFrames).toBe('');
    expect(nativeModule.renderHoldsOverlay).not.toHaveBeenCalled();
  });

  it.each([2, 3])('preserves viewport-sized GPU preparation on an API v%s binary', async (gpuApiVersion) => {
    const { result, rerender } = renderHook(
      ({ renderWidth }) => useNativeClimbRender({ ...board, gpuApiVersion, frames: 'p4131r42', renderWidth }),
      { initialProps: { renderWidth: 936 } },
    );
    await waitFor(() => expect(result.current.gpuStatus).toBe('ready'));
    expect(JSON.parse(result.current.gpuConfigJson!).output_width).toBe(936);
    rerender({ renderWidth: 720 });
    await waitFor(() => expect(result.current.gpuStatus).toBe('ready'));
    expect(JSON.parse(result.current.gpuConfigJson!).output_width).toBe(720);
    expect(nativeModule.renderHoldsOverlay).not.toHaveBeenCalled();
  });

  it('falls back for a failed static config across later taps, with editor veil preserved', async () => {
    const { result, rerender } = renderHook(
      ({ fallback, frames }) =>
        useNativeClimbRender({
          ...board,
          frames,
          maxVeilOpacity: 0,
          gpuFallbackConfigJson: fallback,
        }),
      { initialProps: { fallback: null as string | null, frames: 'p4131r42' } },
    );
    await waitFor(() => expect(result.current.gpuConfigJson).toBeTruthy());
    const failed = result.current.gpuConfigJson!;
    expect(JSON.parse(failed).veil).toBeUndefined();
    rerender({ fallback: failed, frames: 'p4306r43' });
    expect(result.current.gpuConfigJson).toBeNull();
    expect(result.current.gpuStatus).toBe('unavailable');
    await waitFor(() => expect(nativeModule.renderHoldsOverlay).toHaveBeenCalled());
  });

  it.each(['fill', 'glow-fill'] as const)('keeps %s on PNG on older Homewall binaries', async (markStyle) => {
    boardRenderSettingsRef.current = {
      ...DEFAULT_BOARD_RENDER_SETTINGS,
      mode: 'aura',
      boardsesh: { ...DEFAULT_BOARD_RENDER_SETTINGS.boardsesh, markStyle },
    };
    const { result } = renderHook(() => useNativeClimbRender({ ...board, frames: 'p4131r42' }));
    await waitFor(() => expect(nativeModule.renderHoldsOverlay).toHaveBeenCalled());
    expect(result.current.gpuConfigJson).toBeNull();
  });

  it('uses PNG for unsupported soft discs and role codes', async () => {
    boardRenderSettingsRef.current = {
      ...DEFAULT_BOARD_RENDER_SETTINGS,
      mode: 'aura',
      boardsesh: { ...DEFAULT_BOARD_RENDER_SETTINGS.boardsesh, softDisc: true },
    };
    const { result, rerender } = renderHook(({ frames }) => useNativeClimbRender({ ...board, frames }), {
      initialProps: { frames: 'p4131r42' },
    });
    await waitFor(() => expect(nativeModule.renderHoldsOverlay).toHaveBeenCalled());
    expect(result.current.gpuConfigJson).toBeNull();
    boardRenderSettingsRef.current = { ...DEFAULT_BOARD_RENDER_SETTINGS, mode: 'aura' };
    rerender({ frames: 'p4131r12' });
    expect(result.current.gpuConfigJson).toBeNull();
  });

  it('adopts an already-cached PNG for a pending GPU request without rendering', async () => {
    const probe = renderHook(() => useNativeClimbRender({ ...board, frames: 'p4131r42' }));
    await waitFor(() => expect(probe.result.current.gpuConfigJson).toBeTruthy());
    const cacheKey = probe.result.current.overlayCacheKey;
    probe.unmount();
    _renderedOverlaysForTests.set(cacheKey, { uri: 'file:///already-cached.png', generation: 41 });
    const { result } = renderHook(() => useNativeClimbRender({ ...board, frames: 'p4131r42' }));
    await waitFor(() => expect(result.current.gpuConfigJson).toBeTruthy());
    expect(result.current.overlayUri).toBe('file:///already-cached.png');
    expect(nativeModule.renderHoldsOverlay).not.toHaveBeenCalled();
  });

  it('withdraws a hedge that belonged to the previous climb', async () => {
    const { result, rerender } = renderHook(
      ({ frames, hedge }) => useNativeClimbRender({ ...board, frames, gpuHedgeCacheKey: hedge }),
      { initialProps: { frames: 'p4131r42', hedge: null as string | null } },
    );
    await waitFor(() => expect(result.current.gpuConfigJson).toBeTruthy());
    const firstClimbKey = result.current.overlayCacheKey;
    rerender({ frames: 'p4306r43', hedge: firstClimbKey });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(result.current.overlayCacheKey).not.toBe(firstClimbKey);
    expect(nativeModule.renderHoldsOverlay).not.toHaveBeenCalled();
  });

  it('renders at once, without a hedge, when the GPU is not selected', async () => {
    renderHook(() => useNativeClimbRender({ ...board, gpuSurface: false, frames: 'p4131r42' }));
    await waitFor(() => expect(nativeModule.renderHoldsOverlay).toHaveBeenCalledTimes(1));
  });

  it('lets the tap prewarm render while the drawing is cold, and only read the cache once warm', async () => {
    gpuWarmth.allWarm = false;
    const prewarm = { ...board, gpuSurface: false, gpuCatalogueNative: false, cachedOnlyOnceGpuWarm: true };
    const cold = renderHook(() => useNativeClimbRender({ ...prewarm, frames: 'p4131r42' }));
    await waitFor(() => expect(cold.result.current.boardseshRendererAvailable).toBe(true));
    await waitFor(() =>
      expect(
        nativeModule.renderHoldsOverlay.mock.calls.some(([config]) => JSON.parse(config).render_mode === 'aura'),
      ).toBe(true),
    );
    const gpuWarmKey = cold.result.current.gpuWarmKey!;
    cold.unmount();
    const coldRenders = nativeModule.renderHoldsOverlay.mock.calls.length;
    gpuWarmth.warmKeys.add(gpuWarmKey);
    const warm = renderHook(() => useNativeClimbRender({ ...prewarm, frames: 'p4306r43' }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(warm.result.current.overlayUri).toBeNull();
    expect(nativeModule.renderHoldsOverlay).toHaveBeenCalledTimes(coldRenders);
    const cacheKey = warm.result.current.overlayCacheKey;
    warm.unmount();
    _renderedOverlaysForTests.set(cacheKey, { uri: 'file:///warm-me.png', generation: 42 });
    const cached = renderHook(() => useNativeClimbRender({ ...prewarm, frames: 'p4306r43' }));
    expect(cached.result.current.overlayUri).toBe('file:///warm-me.png');
    expect(nativeModule.renderHoldsOverlay).toHaveBeenCalledTimes(coldRenders);
  });

  it('names the same drawing for the play board and the tap prewarm', async () => {
    const playBoard = renderHook(() => useNativeClimbRender({ ...board, renderWidth: 750, frames: 'p4131r42' }));
    const prewarm = renderHook(() =>
      useNativeClimbRender({
        ...board,
        gpuSurface: false,
        cachedOnlyOnceGpuWarm: true,
        renderWidth: 750,
        frames: 'p4306r43',
      }),
    );
    await waitFor(() => expect(playBoard.result.current.gpuConfigJson).toBeTruthy());
    expect(prewarm.result.current.gpuWarmKey).toBe(playBoard.result.current.gpuWarmKey);
    const editor = renderHook(() =>
      useNativeClimbRender({ ...board, renderWidth: 750, maxVeilOpacity: 0, gpuAllowEmpty: true, frames: 'p4131r42' }),
    );
    expect(editor.result.current.gpuWarmKey).not.toBe(playBoard.result.current.gpuWarmKey);
  });

  it('renders the PNG at once for a process-cold drawing and keeps it when the drawing warms', async () => {
    gpuWarmth.allWarm = false;
    const { result, rerender } = renderHook(({ frames }) => useNativeClimbRender({ ...board, frames }), {
      initialProps: { frames: 'p4131r42' },
    });
    await waitFor(() => expect(result.current.gpuConfigJson).toBeTruthy());
    expect(result.current.gpuProcessCold).toBe(true);
    await waitFor(() => expect(result.current.overlayUri).toBe('file:///gpu-fallback.png'));
    expect(nativeModule.renderHoldsOverlay).toHaveBeenCalledTimes(1);
    // Another board presents the drawing: this board's wait began cold and stays so.
    gpuWarmth.warmKeys.add(result.current.gpuWarmKey!);
    rerender({ frames: 'p4131r42' });
    expect(result.current.gpuProcessCold).toBe(true);
    // Its next climb begins a new wait, now warm: GPU first.
    rerender({ frames: 'p4306r43' });
    expect(result.current.gpuProcessCold).toBe(false);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(nativeModule.renderHoldsOverlay).toHaveBeenCalledTimes(1);
  });

  it('reads warmth afresh after the board showed the drawing, as on a return from the background', async () => {
    gpuWarmth.allWarm = false;
    const { result, rerender } = renderHook(
      ({ presented }) => useNativeClimbRender({ ...board, frames: 'p4131r42', gpuPresentedConfigJson: presented }),
      { initialProps: { presented: null as string | null } },
    );
    await waitFor(() => expect(result.current.gpuConfigJson).toBeTruthy());
    expect(result.current.gpuProcessCold).toBe(true);
    gpuWarmth.warmKeys.add(result.current.gpuWarmKey!);
    rerender({ presented: result.current.gpuConfigJson! });
    expect(result.current.gpuProcessCold).toBe(false);
    // Backgrounding released the drawable: the same climb waits again, warm.
    rerender({ presented: null });
    expect(result.current.gpuProcessCold).toBe(false);
  });
});

describe('catalogue Aura GPU render selection on API v5 binaries', () => {
  const nativeModule = {
    boardRendererNative: {},
    renderHoldsOverlay: vi.fn<(config: string, key: string) => Promise<string>>(),
    probeBoardseshRendererSupport: vi.fn<() => Promise<boolean>>(),
  };
  const nativeSurface = { gpuSurface: true, gpuCatalogueNative: true, gpuApiVersion: 5, playSurface: true };
  const catalogueBoards = [
    { boardName: 'kilter', layoutId: 1, sizeId: 7, setIds: '1,20', role: 13 },
    { ...TENSION_ORIGINAL, role: 2 },
    { boardName: 'decoy', layoutId: 2, sizeId: 1, setIds: '1', role: 2 },
    { boardName: 'touchstone', layoutId: 1, sizeId: 1, setIds: '1', role: 2 },
    { ...GRASSHOPPER, role: 2 },
    { boardName: 'soill', layoutId: 1, sizeId: 1, setIds: '1', role: 2 },
    { boardName: 'moonboard', layoutId: 1, sizeId: 1, setIds: '1', role: 43 },
    { ...WOODS_8X10, role: 2 },
  ] as const;
  const twoHolds: MockBoardRenderData = {
    boardWidth: 1080,
    boardHeight: 1504,
    holdsData: [
      { id: 1, mirroredHoldId: 2, cx: 100, cy: 200, r: 20 },
      { id: 2, mirroredHoldId: 1, cx: 200, cy: 200, r: 20 },
    ],
  };

  beforeEach(() => {
    nativeModule.renderHoldsOverlay.mockReset().mockResolvedValue('file:///catalogue-fallback.png');
    nativeModule.probeBoardseshRendererSupport.mockReset().mockResolvedValue(true);
    _setNativeModuleForTests(nativeModule as unknown as Parameters<typeof _setNativeModuleForTests>[0]);
    boardRenderSettingsRef.current = { ...DEFAULT_BOARD_RENDER_SETTINGS, mode: 'aura' };
    getBoardRenderDataMock.mockReturnValue(twoHolds);
  });

  function gpuConfig(json: string | null | undefined): Record<string, unknown> {
    expect(json).toBeTruthy();
    return asRecord(JSON.parse(json!));
  }

  it.each([
    { surface: 'player', frames: 'p1r2', gpuAllowEmpty: false, maxVeilOpacity: undefined },
    { surface: 'editor', frames: '', gpuAllowEmpty: true, maxVeilOpacity: 0 },
  ])('keeps native geometry stable when the $surface viewport changes', async (surface) => {
    const { result, rerender } = renderHook(
      ({ renderWidth, frames, presented }) =>
        useNativeClimbRender({
          ...TENSION_ORIGINAL,
          ...nativeSurface,
          renderWidth,
          frames,
          gpuPresentedConfigJson: presented,
          gpuAllowEmpty: surface.gpuAllowEmpty,
          maxVeilOpacity: surface.maxVeilOpacity,
        }),
      { initialProps: { renderWidth: 936, frames: surface.frames, presented: null as string | null } },
    );
    await waitFor(() => expect(result.current.gpuStatus).toBe('ready'));
    const initialJson = result.current.gpuConfigJson!;
    expect(gpuConfig(initialJson)).toMatchObject({ output_width: 1080, board_width: 1080, board_height: 1504 });
    expect(nativeModule.renderHoldsOverlay).not.toHaveBeenCalled();
    rerender({ renderWidth: 936, frames: surface.frames, presented: initialJson });
    rerender({ renderWidth: 720, frames: 'p2r2', presented: initialJson });
    expect(result.current.gpuConfigJson).toBe(initialJson);
    expect(result.current.gpuFrames).toBe('p2r2');
    expect(nativeModule.renderHoldsOverlay).not.toHaveBeenCalled();
  });

  it('uses the requested PNG size when native-resolution GPU geometry exceeds its limit', async () => {
    getBoardRenderDataMock.mockReturnValue({ ...twoHolds, boardWidth: 1537 });
    const { result } = renderHook(() =>
      useNativeClimbRender({ ...TENSION_ORIGINAL, ...nativeSurface, frames: 'p1r2', renderWidth: 936 }),
    );
    await waitFor(() => expect(nativeModule.renderHoldsOverlay).toHaveBeenCalled());
    expect(result.current.gpuConfigJson).toBeNull();
    expect(JSON.parse(nativeModule.renderHoldsOverlay.mock.calls.at(-1)![0]).output_width).toBe(936);
  });

  it.each(catalogueBoards)('reuses full geometry through $boardName player and editor frame changes', async (board) => {
    const firstFrames = `p1r${board.role}`;
    const { result, rerender } = renderHook(
      ({ frames, presented }) =>
        useNativeClimbRender({
          ...board,
          ...nativeSurface,
          frames,
          gpuAllowEmpty: true,
          gpuPresentedConfigJson: presented,
        }),
      { initialProps: { frames: firstFrames, presented: null as string | null } },
    );
    await waitFor(() => expect(result.current.gpuStatus).toBe('ready'));
    const initialJson = result.current.gpuConfigJson!;
    const config = gpuConfig(initialJson);
    expect(config.render_mode).toBe('aura');
    expect(config.output_width).toBe(1080);
    expect(config.frames).toBe('');
    expect(config.mirrored).toBe(false);
    expect(config.holds).toEqual([
      expect.objectContaining({ id: 1, mirroredHoldId: 2 }),
      expect.objectContaining({ id: 2, mirroredHoldId: 1 }),
    ]);
    expect(nativeModule.renderHoldsOverlay).not.toHaveBeenCalled();
    rerender({ frames: firstFrames, presented: initialJson });
    rerender({ frames: `p2r${board.role}`, presented: initialJson });
    expect(result.current.gpuConfigJson).toBe(initialJson);
    expect(result.current.gpuFrames).toBe(`p2r${board.role}`);
    rerender({ frames: '', presented: initialJson });
    expect(result.current.gpuConfigJson).toBe(initialJson);
    expect(result.current.gpuFrames).toBe('');
    expect(nativeModule.renderHoldsOverlay).not.toHaveBeenCalled();
  });

  it('keeps all thirty Kilter state codes, Original roles and colour-mode aliases', async () => {
    const { result, rerender } = renderHook(
      ({ frames, presented }) =>
        useNativeClimbRender({ ...catalogueBoards[0], ...nativeSurface, frames, gpuPresentedConfigJson: presented }),
      { initialProps: { frames: 'p1r12p2r13', presented: null as string | null } },
    );
    await waitFor(() => expect(result.current.gpuStatus).toBe('ready'));
    const initialJson = result.current.gpuConfigJson!;
    const states = asRecord(gpuConfig(initialJson).hold_state_map);
    expect(Object.keys(states)).toHaveLength(30);
    expect(states[12]).toEqual({ color: '#00FF00', role: 'starting' });
    expect(states[13]).toEqual({ color: '#4DF5FD', role: 'hand' });
    expect(states[14]).toEqual({ color: '#FF00FF', role: 'finish' });
    expect(states[15]).toEqual({ color: '#FFAA00', role: 'foot' });
    expect(states[37]).toEqual({ color: '#FF00FF', role: 'hand' });
    expect(states[41]).toEqual({ color: '#0000FF', role: 'hand' });
    expect(nativeModule.renderHoldsOverlay).not.toHaveBeenCalled();
    rerender({ frames: 'p1r12p2r13', presented: initialJson });
    rerender({ frames: 'p1r14p2r15', presented: initialJson });
    expect(result.current.gpuConfigJson).toBe(initialJson);
    rerender({ frames: 'p1r37p2r41', presented: initialJson });
    expect(result.current.gpuConfigJson).toBe(initialJson);
    expect(nativeModule.renderHoldsOverlay).not.toHaveBeenCalled();
  });

  it('keeps Tension alternate role codes and includes the catalogue Spray layout', async () => {
    const board = { boardName: 'tension' as const, layoutId: 11, sizeId: 6, setIds: '12' };
    const { result, rerender } = renderHook(
      ({ frames, presented }) =>
        useNativeClimbRender({ ...board, ...nativeSurface, frames, gpuPresentedConfigJson: presented }),
      { initialProps: { frames: 'p1r5p2r6', presented: null as string | null } },
    );
    await waitFor(() => expect(result.current.gpuStatus).toBe('ready'));
    const initialJson = result.current.gpuConfigJson!;
    const states = asRecord(gpuConfig(initialJson).hold_state_map);
    expect(Object.keys(states)).toHaveLength(8);
    for (const code of [1, 2, 3, 4]) expect(states[code + 4]).toEqual(states[code]);
    expect(states[6]).toEqual({ color: '#4DF5FD', role: 'hand' });
    expect(nativeModule.renderHoldsOverlay).not.toHaveBeenCalled();
    rerender({ frames: 'p1r5p2r6', presented: initialJson });
    rerender({ frames: 'p1r7p2r8', presented: initialJson });
    expect(result.current.gpuConfigJson).toBe(initialJson);
    expect(nativeModule.renderHoldsOverlay).not.toHaveBeenCalled();
  });

  it('preserves MoonBoard annotations and its purple and pink preview colours', async () => {
    const { result, rerender } = renderHook(
      ({ frames, presented }) =>
        useNativeClimbRender({ ...catalogueBoards[6], ...nativeSurface, frames, gpuPresentedConfigJson: presented }),
      { initialProps: { frames: 'p1r46p2r47', presented: null as string | null } },
    );
    await waitFor(() => expect(result.current.gpuStatus).toBe('ready'));
    const initialJson = result.current.gpuConfigJson!;
    const states = asRecord(gpuConfig(initialJson).hold_state_map);
    expect(states[46]).toEqual({ color: '#FFE066', render_style: 'above-marker' });
    expect(states[47]).toEqual({ color: '#C084FC', role: 'hand' });
    expect(states[48]).toEqual({ color: '#FF7DBB', role: 'hand' });
    expect(nativeModule.renderHoldsOverlay).not.toHaveBeenCalled();
    rerender({ frames: 'p1r46p2r47', presented: initialJson });
    rerender({ frames: 'p1r48p2r46', presented: initialJson });
    expect(result.current.gpuConfigJson).toBe(initialJson);
    expect(result.current.gpuFrames).toBe('p1r48p2r46');
    expect(nativeModule.renderHoldsOverlay).not.toHaveBeenCalled();
  });

  it('retains Woods placement zero and its own start and foot roles', async () => {
    getBoardRenderDataMock.mockReturnValue({
      ...twoHolds,
      holdsData: [{ ...twoHolds.holdsData[0], id: 0 }, twoHolds.holdsData[1]],
    });
    const { result } = renderHook(() => useNativeClimbRender({ ...WOODS_8X10, ...nativeSurface, frames: 'p0r2p2r4' }));
    await waitFor(() => expect(result.current.gpuStatus).toBe('ready'));
    const config = gpuConfig(result.current.gpuConfigJson);
    expect(config.holds).toEqual(expect.arrayContaining([expect.objectContaining({ id: 0 })]));
    const states = asRecord(config.hold_state_map);
    expect(states[1]).toEqual({ color: '#FF00FF', role: 'foot' });
    expect(states[4]).toEqual({ color: '#00DD00', role: 'starting' });
    expect(result.current.gpuFrames).toBe('p0r2p2r4');
    expect(nativeModule.renderHoldsOverlay).not.toHaveBeenCalled();
  });

  it('uses local PNG rendering for custom spray walls', async () => {
    const { result } = renderHook(() =>
      useNativeClimbRender({
        boardName: 'spray',
        layoutId: 7431,
        sizeId: 7431,
        setIds: '1',
        ...nativeSurface,
        frames: 'p1r2',
      }),
    );
    await waitFor(() => expect(nativeModule.renderHoldsOverlay).toHaveBeenCalled());
    expect(result.current.gpuConfigJson).toBeNull();
    expect(result.current.gpuStatus).toBe('unavailable');
  });

  it('keeps Classic on its existing renderer even when the new binary is available', async () => {
    boardRenderSettingsRef.current = { ...DEFAULT_BOARD_RENDER_SETTINGS, mode: 'classic' };
    const { result } = renderHook(() =>
      useNativeClimbRender({ ...TENSION_ORIGINAL, ...nativeSurface, frames: 'p1r2' }),
    );
    await waitFor(() => expect(nativeModule.renderHoldsOverlay).toHaveBeenCalled());
    expect(result.current.gpuConfigJson).toBeNull();
    const config = asRecord(JSON.parse(nativeModule.renderHoldsOverlay.mock.calls.at(-1)![0]));
    expect(config.render_mode).toBeUndefined();
    expect(asRecord(config.hold_state_map)[2]).toEqual({ color: '#4444FF' });
  });

  it.each(['fill', 'glow-fill'] as const)('keeps exact %s pixels on the PNG path', async (markStyle) => {
    boardRenderSettingsRef.current = {
      ...DEFAULT_BOARD_RENDER_SETTINGS,
      mode: 'aura',
      boardsesh: { ...DEFAULT_BOARD_RENDER_SETTINGS.boardsesh, markStyle },
    };
    const { result } = renderHook(() =>
      useNativeClimbRender({ ...TENSION_ORIGINAL, ...nativeSurface, frames: 'p1r2' }),
    );
    await waitFor(() => expect(nativeModule.renderHoldsOverlay).toHaveBeenCalled());
    expect(result.current.gpuConfigJson).toBeNull();
    const config = asRecord(JSON.parse(nativeModule.renderHoldsOverlay.mock.calls.at(-1)![0]));
    expect(config.mark_style).toBe(markStyle);
    expect(config.output_width).toBe(twoHolds.boardWidth);
  });

  it('accepts the tallest native output without reducing resolution', async () => {
    getBoardRenderDataMock.mockReturnValue({ ...twoHolds, boardHeight: 2304 });
    const { result, rerender } = renderHook(
      ({ hedge }) =>
        useNativeClimbRender({ ...TENSION_ORIGINAL, ...nativeSurface, frames: 'p1r2', gpuHedgeCacheKey: hedge }),
      { initialProps: { hedge: null as string | null } },
    );
    await waitFor(() => expect(result.current.gpuStatus).toBe('ready'));
    expect(gpuConfig(result.current.gpuConfigJson)).toMatchObject({ output_width: 1080, board_height: 2304 });
    expect(nativeModule.renderHoldsOverlay).not.toHaveBeenCalled();
    // The hedge renders the same full-resolution PNG the fallback would.
    rerender({ hedge: result.current.overlayCacheKey });
    await waitFor(() => expect(nativeModule.renderHoldsOverlay).toHaveBeenCalledTimes(1));
    expect(JSON.parse(nativeModule.renderHoldsOverlay.mock.calls[0][0])).toMatchObject({
      output_width: 1080,
      board_height: 2304,
      frames: 'p1r2',
    });
  });

  it.each([
    { reason: 'width', dimensions: { boardWidth: 1537 }, holdCount: 2 },
    { reason: 'height', dimensions: { boardHeight: 2305 }, holdCount: 2 },
    { reason: 'hold count', dimensions: {}, holdCount: 1025 },
  ])(
    'falls back at the native $reason limit while preserving the requested output',
    async ({ dimensions, holdCount }) => {
      getBoardRenderDataMock.mockReturnValue({
        ...twoHolds,
        ...dimensions,
        holdsData: Array.from({ length: holdCount }, (_, index) => ({
          id: index + 1,
          mirroredHoldId: null,
          cx: 100,
          cy: 200,
          r: 20,
        })),
      });
      const { result } = renderHook(() =>
        useNativeClimbRender({ ...TENSION_ORIGINAL, ...nativeSurface, frames: 'p1r2' }),
      );
      await waitFor(() => expect(nativeModule.renderHoldsOverlay).toHaveBeenCalled());
      expect(result.current.gpuConfigJson).toBeNull();
      expect(result.current.gpuStatus).toBe('unavailable');
      const config = asRecord(JSON.parse(nativeModule.renderHoldsOverlay.mock.calls.at(-1)![0]));
      expect(config.output_width).toBe(dimensions.boardWidth ?? twoHolds.boardWidth);
      expect(config.board_height).toBe(dimensions.boardHeight ?? twoHolds.boardHeight);
      expect(config.holds).toHaveLength(holdCount);
    },
  );
});
