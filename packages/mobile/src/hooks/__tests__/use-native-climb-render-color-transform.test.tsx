// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { HOLD_STATE_MAP, getHoldDisplayColor } from '@boardsesh/board-constants/hold-states';
import type { BoardName } from '@boardsesh/shared-schema';

// The read-only hold-colour transform seam: a preview card can redraw the
// climber's OWN board through a colour-vision-deficiency simulation without
// writing the override store (and therefore without ever reaching the physical
// board's LEDs). The property that matters most here is cache isolation — a
// simulated card must never render over the real board's PNG.
//
// Only the holds overlay is simulated; the board photograph is drawn as-is (see
// the `holdColorTransform` doc comment for why). Nothing here asserts anything
// about the photo.

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

// Traced art is irrelevant to colour: stub it away so these cases don't depend
// on which board the shards cover. A null geometry is the documented fallback
// (the mode still renders, it just glows a ring), and buildBoardseshFields —
// where the veil colour lives — runs either way.
vi.mock('@boardsesh/board-art-geometry', () => ({
  loadBoardArtGeometry: vi.fn(() => null),
  getWallLightness: vi.fn(() => 0.35),
}));

const boardRenderSettingsRef = vi.hoisted(() => ({
  current: { mode: 'classic' as 'default' | 'classic' | 'boardsesh', boardsesh: {} as Record<string, unknown> },
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

const { BOARD_FIELD_COLORS, DEFAULT_BOARD_RENDER_SETTINGS, DEFAULT_BOARDSESH_RENDER_SETTINGS } =
  await import('../../lib/board-render-settings');

const {
  useNativeClimbRender,
  buildCacheKey,
  _getBoardConfigForTests,
  _resetBoardConfigCacheForTests,
  _resetWarmupForTests,
  _resetBoardseshSupportForTests,
  _renderedOverlaysForTests,
  _inflightRendersForTests,
  _unsupportedRenderSignaturesForTests,
  _setNativeModuleForTests,
} = await import('../use-native-climb-render');

type BoardseshConfigInputs = NonNullable<Parameters<typeof _getBoardConfigForTests>[11]>;

const KILTER = { boardName: 'kilter' as const, layoutId: 1, sizeId: 10, setIds: '24' };
const KILTER_HOLDS: MockBoardRenderData = {
  boardWidth: 1000,
  boardHeight: 1200,
  holdsData: [{ id: 1, mirroredHoldId: null, cx: 100, cy: 200, r: 20 }],
};
/** Kilter role code 42 is HAND — enough lit holds for a real signature. */
const KILTER_FRAMES = 'p1r42';

// Module constants: both props MUST be referentially stable, so the suite holds
// them the way a real caller does rather than minting closures per render.
/** Stand-in for simulateCvd — deterministic, and obviously not identity. */
const SWAP_RED_AND_BLUE = (hex: string): string => {
  const match = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex.trim());
  if (!match) return hex;
  return `#${match[3]}${match[2]}${match[1]}`.toLowerCase();
};
const IDENTITY = (hex: string): string => hex;

function asRecord(value: unknown): Record<string, unknown> {
  expect(value && typeof value === 'object' && !Array.isArray(value)).toBe(true);
  return value as Record<string, unknown>;
}

function buildConfig({
  renderSignature = 'default',
  boardsesh = null,
  holdColorTransform,
  boardName = 'kilter' as BoardName,
}: {
  renderSignature?: string;
  boardsesh?: BoardseshConfigInputs | null;
  holdColorTransform?: (hex: string) => string;
  boardName?: BoardName;
} = {}): Record<string, unknown> {
  const boardConfig = _getBoardConfigForTests(
    boardName,
    KILTER.layoutId,
    KILTER.sizeId,
    KILTER.setIds,
    false,
    undefined,
    {},
    {},
    1,
    1,
    renderSignature,
    boardsesh,
    KILTER_FRAMES,
    holdColorTransform,
  );
  expect(boardConfig).not.toBeNull();
  return asRecord(boardConfig?.configBase);
}

function boardseshInputs(): BoardseshConfigInputs {
  return {
    settings: DEFAULT_BOARDSESH_RENDER_SETTINGS,
    glowFalloff: 'soft',
    fieldColor: BOARD_FIELD_COLORS.dark,
    veilOpacity: 0.6,
  };
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
  boardRenderSettingsRef.current = { ...DEFAULT_BOARD_RENDER_SETTINGS, mode: 'classic' };
  getBoardRenderDataMock.mockReturnValue(KILTER_HOLDS);
});

describe('holdColorTransform in the built config', () => {
  it('rewrites every hold colour the render would have drawn', () => {
    const plain = asRecord(buildConfig().hold_state_map);
    const simulated = asRecord(
      buildConfig({ renderSignature: 'default.cvd-swap', holdColorTransform: SWAP_RED_AND_BLUE }).hold_state_map,
    );

    const codes = Object.keys(HOLD_STATE_MAP.kilter);
    expect(codes.length).toBeGreaterThan(0);
    for (const code of codes) {
      const plainColor = asRecord(plain[code]).color as string;
      const simulatedColor = asRecord(simulated[code]).color as string;
      expect(simulatedColor).toBe(SWAP_RED_AND_BLUE(plainColor));
    }
    // Not a no-op on this board: at least one role actually moved.
    expect(codes.some((code) => asRecord(simulated[code]).color !== asRecord(plain[code]).color)).toBe(true);
  });

  it('wraps the colour the render would REALLY have used, not the raw LED colour', () => {
    // The wrap sits after the display-palette pick, so what goes into the
    // transform is the calibrated on-screen colour — the same one a real render
    // draws — rather than the LED colour only the BLE path wants.
    const simulated = asRecord(
      buildConfig({ renderSignature: 'default.cvd-swap', holdColorTransform: SWAP_RED_AND_BLUE }).hold_state_map,
    );
    for (const [code, stateInfo] of Object.entries(HOLD_STATE_MAP.kilter)) {
      const expected = SWAP_RED_AND_BLUE(getHoldDisplayColor(stateInfo, 'classic'));
      expect(asRecord(simulated[code]).color).toBe(expected);
    }
  });

  it("simulates the Boardsesh veil's hue but leaves its strength alone", () => {
    const plain = buildConfig({ renderSignature: 'default.mode-boardsesh-plain', boardsesh: boardseshInputs() });
    const simulated = buildConfig({
      renderSignature: 'default.mode-boardsesh-plain.cvd-swap',
      boardsesh: boardseshInputs(),
      holdColorTransform: SWAP_RED_AND_BLUE,
    });

    const plainVeil = asRecord(plain.veil);
    const simulatedVeil = asRecord(simulated.veil);
    // resolveVeilOpacity has already run against the REAL field colour, so a
    // simulated card washes the wall exactly as hard as the real board does.
    expect(simulatedVeil.opacity).toBe(plainVeil.opacity);
    expect(simulatedVeil.color).toBe(SWAP_RED_AND_BLUE(plainVeil.color as string));
  });

  it('leaves the config untouched when no transform is passed', () => {
    // Every existing caller omits the prop. An identity transform and no
    // transform must produce the same bytes — i.e. the wrap changed the value
    // path only, never the config's shape.
    const withoutTransform = JSON.stringify(buildConfig());
    _resetBoardConfigCacheForTests();
    const withIdentity = JSON.stringify(
      buildConfig({ renderSignature: 'default.identity', holdColorTransform: IDENTITY }),
    );
    expect(withIdentity).toBe(withoutTransform);

    // And the un-transformed colours are still exactly the board's palette.
    const holdStateMap = asRecord(buildConfig().hold_state_map);
    for (const [code, stateInfo] of Object.entries(HOLD_STATE_MAP.kilter)) {
      expect(asRecord(holdStateMap[code]).color).toBe(getHoldDisplayColor(stateInfo, 'classic'));
    }
  });
});

describe('holdColorTransformKey in the cache key', () => {
  it('keeps a Boardsesh render’s simulation token through the empty-frames collapse', () => {
    // buildCacheKey throws away everything before `.mode-boardsesh` when nothing
    // is lit. The simulation token trails the board half precisely so it
    // survives that — a Boardsesh render with no frames still paints a
    // (simulated) veil.
    const real = buildCacheKey('kilter', 1, 10, '24', '', false, undefined, 'default.mode-boardsesh-soft');
    const simulated = buildCacheKey(
      'kilter',
      1,
      10,
      '24',
      '',
      false,
      undefined,
      'default.mode-boardsesh-soft.cvd-deuteranopia',
    );
    expect(simulated).not.toBe(real);
  });
});

describe('useNativeClimbRender colour-simulation cache isolation', () => {
  const nativeModule = {
    boardRendererNative: {},
    renderHoldsOverlay: vi.fn<(configJson: string, cacheKey: string) => Promise<string>>(),
    probeBoardseshRendererSupport: vi.fn<() => Promise<boolean>>(),
  };

  function sentCacheKeys(): string[] {
    return nativeModule.renderHoldsOverlay.mock.calls.map(([, cacheKey]) => cacheKey);
  }

  beforeEach(() => {
    nativeModule.renderHoldsOverlay.mockReset();
    nativeModule.renderHoldsOverlay.mockResolvedValue('file:///overlay.png');
    nativeModule.probeBoardseshRendererSupport.mockReset();
    nativeModule.probeBoardseshRendererSupport.mockResolvedValue(false);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    _setNativeModuleForTests(nativeModule as unknown as Parameters<typeof _setNativeModuleForTests>[0]);
  });

  async function keyForTransform(transformKey?: string): Promise<string> {
    nativeModule.renderHoldsOverlay.mockClear();
    _renderedOverlaysForTests.clear();
    _inflightRendersForTests.clear();
    renderHook(() =>
      useNativeClimbRender({
        ...KILTER,
        frames: KILTER_FRAMES,
        ...(transformKey ? { holdColorTransform: SWAP_RED_AND_BLUE, holdColorTransformKey: transformKey } : {}),
      }),
    );
    await waitFor(() => expect(sentCacheKeys().length).toBeGreaterThan(0));
    return sentCacheKeys()[0];
  }

  it('renders a simulated card under its own cache key, never the real board’s', async () => {
    // THE property this seam exists for: a colour-blind preview must not write
    // its PNG over the file the play view is reading.
    const realKey = await keyForTransform();
    const simulatedKey = await keyForTransform('cvd-deuteranopia');
    expect(simulatedKey).not.toBe(realKey);
  });

  it('gives each simulation its own key', async () => {
    const deuteranopia = await keyForTransform('cvd-deuteranopia');
    const protanopia = await keyForTransform('cvd-protanopia');
    const tritanopia = await keyForTransform('cvd-tritanopia');
    expect(new Set([deuteranopia, protanopia, tritanopia]).size).toBe(3);
  });

  it('leaves an un-simulated render’s key byte-identical to today’s', async () => {
    const key = await keyForTransform();
    expect(key).toBe(buildCacheKey('kilter', 1, 10, '24', KILTER_FRAMES, false, undefined));
  });
});
