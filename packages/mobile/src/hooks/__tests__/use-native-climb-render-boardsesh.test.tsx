// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
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
vi.mock('../../lib/error-reporting', () => ({ reportError: reportErrorMock }));

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

/**
 * Woods 8x10 (layout 1, size 1) — the one board traced off a white key rather
 * than off an alpha channel, because its art is a photograph of the hold set on
 * a white sweep. Only ever fed to the REAL `getBoardRenderData`.
 */
const WOODS_8X10 = { boardName: 'woods' as const, layoutId: 1, sizeId: 1, setIds: '1' };

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

    const auraConfig = buildConfig(TB2_MIRROR, {
      frames: 'p304r2',
      boardsesh: boardseshInputs(),
      renderSignature: 'boardsesh-hand',
    });
    expect(stateInfoByColorRole(auraConfig, 2)?.color).toBe('#6980FF');

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
    // 467 of 485 — 16 are bolts sitting on bare white sweep, which honestly has
    // no hold to trace, and 2 traced into a ring that crosses itself and were
    // rejected for it. Pinned by gate 4 in the package too.
    expect(Object.keys(geometry?.outlines ?? {}).length).toBe(467);

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
    expect(getWallLightness(WOODS_8X10)).toEqual({ mean: 0.53, coverage: 0.932 });
    expect(getWallLightness({ boardName: 'woods', layoutId: 1, sizeId: 2 })).toEqual({
      mean: 0.54,
      coverage: 0.931,
    });

    expect(resolveVeilOpacity(DEFAULT_BOARDSESH_RENDER_SETTINGS, getWallLightness(WOODS_8X10), DARK_FIELD)).toBe(0.3);
    // The 12x12 is a KNIFE EDGE and is pinned deliberately: its gap to the dark
    // field is 0.339976 against a strong-bucket threshold of 0.34, so it takes
    // the soft wash by 24 millionths. A re-export of the board photo that lifts
    // its mean by 0.001 flips it to 0.6, and this is what says so.
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
    expect(classicKey).toMatch(/^v14_/);
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
