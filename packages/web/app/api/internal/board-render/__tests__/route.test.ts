// @vitest-environment node

import { describe, it, expect, vi, afterEach, beforeEach } from 'vite-plus/test';
import { NextRequest } from 'next/server';
import { resetBoardRenderCaches } from '@/app/lib/board-render-cache';
import { createOgImageHeaders } from '@/app/lib/seo/og';
import { GET } from '../route';

// The route builds its semaphore once, at module load, from this env var —
// hoisted so it is set before `../route` is imported. One slot makes the
// concurrency and load-shedding behaviour observable with a handful of requests.
vi.hoisted(() => {
  process.env.BOARD_RENDER_CONCURRENCY = '1';
});

// Renders in flight right now, and the most that ever overlapped. Incremented
// when a render starts its WASM pass, decremented when its encode finishes.
let activeRenders = 0;
let peakActiveRenders = 0;
// When set, every encode parks here — holds renders open so a test can watch
// what the semaphore admits.
let renderGate: Promise<void> | null = null;

let releaseRenderGate: (() => void) | null = null;

function openRenderGate(): () => void {
  let resolveGate!: () => void;
  renderGate = new Promise<void>((resolve) => {
    resolveGate = resolve;
  });
  releaseRenderGate = () => {
    renderGate = null;
    resolveGate();
  };
  return releaseRenderGate;
}

/** Let every pending microtask (and timer callback) settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// Mock WASM module - returns raw RGBA with 8-byte dimension header
const mockRenderOverlay = vi.fn((_config: string) => {
  activeRenders += 1;
  peakActiveRenders = Math.max(peakActiveRenders, activeRenders);
  // 2x2 pixel image: 8 bytes header + 16 bytes RGBA data
  const buf = new Uint8Array(8 + 16);
  const view = new DataView(buf.buffer);
  view.setUint32(0, 2, true); // width = 2
  view.setUint32(4, 2, true); // height = 2
  // Fill RGBA with semi-transparent red
  for (let i = 8; i < 24; i += 4) {
    buf[i] = 255; // R
    buf[i + 1] = 0; // G
    buf[i + 2] = 0; // B
    buf[i + 3] = 128; // A
  }
  return buf;
});
vi.mock('@boardsesh/board-renderer-wasm', () => ({
  default: vi.fn(),
  initSync: vi.fn(),
  render_overlay: (config: string) => mockRenderOverlay(config),
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(() => Promise.resolve(new Uint8Array([0]))),
}));
const mockExistsSync = vi.fn<(path: string) => boolean>(() => true);
vi.mock('fs', () => ({
  existsSync: (path: string) => mockExistsSync(path),
}));

// Mock sharp - tracks the chained operations the pipeline drives.
const mockComposite = vi.fn();
const mockResize = vi.fn();
const mockLinear = vi.fn();
const mockWebpOptions = vi.fn();
const mockPngOptions = vi.fn();
const mockJpegOptions = vi.fn();
// Substrings of an input path whose decode should reject, per test.
const failingInputPaths: string[] = [];

/**
 * Terminal encode: the bytes carry the format and its options, so two renders
 * that differ only in encode settings (thumbnail vs full, lossless vs lossy)
 * produce visibly different bodies. Also the point where a render is counted as
 * finished, and where the gate parks it.
 */
const terminalEncode = (kind: string, options: unknown) => {
  const bytes = Buffer.from(`${kind}:${JSON.stringify(options ?? null)}`);
  return vi.fn(async () => {
    if (renderGate) await renderGate;
    activeRenders = Math.max(0, activeRenders - 1);
    return bytes;
  });
};

const mockSharpInstance = (shouldFail: boolean) => {
  const instance = {
    composite: vi.fn((...args: unknown[]) => {
      mockComposite(...args);
      return instance;
    }),
    resize: vi.fn((...args: unknown[]) => {
      mockResize(...args);
      return instance;
    }),
    ensureAlpha: vi.fn(() => instance),
    raw: vi.fn(() => instance),
    linear: vi.fn((...args: unknown[]) => {
      mockLinear(...args);
      return instance;
    }),
    // Raw-pixel output: the board base and the per-layer decodes.
    toBuffer: vi.fn(() =>
      shouldFail ? Promise.reject(new Error('corrupt image')) : Promise.resolve(Buffer.from([0xb0])),
    ),
    webp: vi.fn((opts: unknown) => {
      mockWebpOptions(opts);
      return { toBuffer: terminalEncode('webp', opts) };
    }),
    png: vi.fn((opts: unknown) => {
      mockPngOptions(opts);
      return { toBuffer: terminalEncode('png', opts) };
    }),
    jpeg: vi.fn((opts: unknown) => {
      mockJpegOptions(opts);
      return { toBuffer: terminalEncode('jpeg', opts) };
    }),
  };
  return instance;
};
const mockSharpDefault = vi.fn((input?: unknown, _options?: unknown) =>
  mockSharpInstance(typeof input === 'string' && failingInputPaths.some((fragment) => input.includes(fragment))),
);
vi.mock('sharp', () => ({
  // `cache`/`concurrency` are called once at route module load (sharp-runtime).
  default: Object.assign((input?: unknown, options?: unknown) => mockSharpDefault(input, options), {
    cache: () => undefined,
    concurrency: () => undefined,
  }),
}));

vi.mock('@/app/lib/board-utils', () => ({
  getBoardDetailsForBoard: vi.fn(() => ({
    board_name: 'kilter',
    layout_id: 1,
    size_id: 7,
    set_ids: [1, 20],
    boardWidth: 1080,
    boardHeight: 1350,
    holdsData: [
      { id: 1073, mirroredHoldId: null, cx: 200, cy: 300, r: 20 },
      { id: 1090, mirroredHoldId: null, cx: 500, cy: 600, r: 20 },
    ],
    images_to_holds: { 'test.png': [] },
    edge_left: 0,
    edge_right: 144,
    edge_bottom: 0,
    edge_top: 180,
  })),
}));

vi.mock('@/app/components/board-renderer/types', () => ({
  THUMBNAIL_WIDTH: 200,
  HOLD_STATE_MAP: {
    kilter: {
      42: { name: 'STARTING', color: '#00FF00' },
      43: { name: 'HAND', color: '#00FFFF' },
      44: { name: 'FINISH', color: '#FF00FF' },
      45: { name: 'FOOT', color: '#FFAA00' },
    },
    tension: {},
    moonboard: {
      42: { name: 'STARTING', color: '#00FF00' },
      43: { name: 'HAND', color: '#0000FF' },
      44: { name: 'FINISH', color: '#FF0000' },
      46: { name: 'AUX', color: '#FFE066', renderStyle: 'above-marker' },
    },
    decoy: {
      1: { name: 'STARTING', color: '#00FF00' },
      2: { name: 'HAND', color: '#0000FF' },
      3: { name: 'FINISH', color: '#FF0000' },
      4: { name: 'FOOT', color: '#FF00FF' },
    },
    touchstone: {
      1: { name: 'STARTING', color: '#00FF00' },
      2: { name: 'HAND', color: '#0000FF' },
      3: { name: 'FINISH', color: '#FF0000' },
      4: { name: 'FOOT', color: '#FF00FF' },
    },
    grasshopper: {
      1: { name: 'STARTING', color: '#00FF00', displayColor: '#00DD00' },
      2: { name: 'HAND', color: '#0000FF', displayColor: '#4455FF' },
      3: { name: 'FINISH', color: '#FF0000', displayColor: '#FF0000' },
      4: { name: 'FOOT', color: '#FF00FF', displayColor: '#FF00FF' },
    },
    soill: {
      1: { name: 'STARTING', color: '#00FF00' },
      2: { name: 'HAND', color: '#0000FF' },
      3: { name: 'FINISH', color: '#FF0000' },
      4: { name: 'FOOT', color: '#FF00FF' },
    },
  },
}));

vi.mock('@/app/lib/seo/og', () => ({
  OG_IMAGE_WIDTH: 1200,
  OG_IMAGE_HEIGHT: 630,
  createOgImageHeaders: vi.fn(({ contentType, serverTiming }: { contentType: string; serverTiming?: string }) => ({
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=31536000, s-maxage=31536000, immutable',
    'CDN-Cache-Control': 'public, s-maxage=31536000, immutable',
    'Vercel-CDN-Cache-Control': 'public, s-maxage=31536000, immutable',
    ...(serverTiming ? { 'Server-Timing': serverTiming } : {}),
  })),
}));

function makeRequest(params: Record<string, string>): NextRequest {
  const url = new URL('http://localhost:3000/api/internal/board-render');
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new NextRequest(url);
}

const validParams = {
  board_name: 'kilter',
  layout_id: '1',
  size_id: '7',
  set_ids: '1,20',
  frames: 'p1073r42p1090r43',
};

describe('board-render API route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    failingInputPaths.length = 0;
    activeRenders = 0;
    peakActiveRenders = 0;
    renderGate = null;
    releaseRenderGate = null;
    // Module-level caches outlive a request by design — reset them so one
    // test's render can't serve another test's request.
    resetBoardRenderCaches();
  });

  afterEach(async () => {
    // A failing gated test would otherwise leave its renders parked forever,
    // holding the semaphore and timing out every test after it. Release the
    // gate and drain the queue so a failure stays local to its own test.
    releaseRenderGate?.();
    releaseRenderGate = null;
    await flush();
    await flush();
  });

  it('returns 200 with WebP content for valid request', async () => {
    const response = await GET(makeRequest(validParams));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/webp');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, s-maxage=31536000, immutable');
    expect(response.headers.get('CDN-Cache-Control')).toBe('public, s-maxage=31536000, immutable');
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('public, s-maxage=31536000, immutable');
  });

  it('returns 400 when board_name is missing', async () => {
    const { board_name: _, ...params } = validParams;
    const response = await GET(makeRequest(params));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Missing required parameters');
  });

  it('returns 400 when frames is missing', async () => {
    const { frames: _, ...params } = validParams;
    const response = await GET(makeRequest(params));
    expect(response.status).toBe(400);
  });

  it('accepts an empty frames string for board-only previews', async () => {
    const response = await GET(makeRequest({ ...validParams, frames: '', include_background: '1', format: 'png' }));

    expect(response.status).toBe(200);
    const configJson = mockRenderOverlay.mock.calls[0][0];
    const config = JSON.parse(configJson);
    expect(config.frames).toBe('');
  });

  it('accepts quoted Aurora delta frame segments', async () => {
    const frames = 'p1073r42,"p1090r43,"x1073p1100r44';
    const response = await GET(makeRequest({ ...validParams, frames }));

    expect(response.status).toBe(200);
    const configJson = mockRenderOverlay.mock.calls[0][0];
    const config = JSON.parse(configJson);
    expect(config.frames).toBe(frames);
  });

  it('returns 400 for invalid board_name', async () => {
    const response = await GET(makeRequest({ ...validParams, board_name: 'invalid' }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Invalid board_name');
  });

  it('returns 400 for invalid output format', async () => {
    const response = await GET(makeRequest({ ...validParams, format: 'gif' }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Invalid format');
    expect(mockRenderOverlay).not.toHaveBeenCalled();
    expect(mockJpegOptions).not.toHaveBeenCalled();
  });

  describe('boardsesh render options (issue #2202)', () => {
    it('defaults to a classic config with no boardsesh-mode fields', async () => {
      await GET(makeRequest(validParams));
      const config = JSON.parse(mockRenderOverlay.mock.calls[0][0]);
      expect(config.render_mode).toBeUndefined();
      expect(config.glow_falloff).toBeUndefined();
      expect(config.glyphs).toBeUndefined();
      expect(config.veil).toBeUndefined();
    });

    it('reaches the builder with render_mode=boardsesh and glow_falloff=plateau', async () => {
      await GET(makeRequest({ ...validParams, render_mode: 'boardsesh', glow_falloff: 'plateau' }));
      const config = JSON.parse(mockRenderOverlay.mock.calls[0][0]);
      expect(config.render_mode).toBe('boardsesh');
      expect(config.glow_falloff).toBe('plateau');
      expect(config.glyphs).toBe('off');
    });

    it('maps glyphs=1 to "role"', async () => {
      await GET(makeRequest({ ...validParams, render_mode: 'boardsesh', glyphs: '1' }));
      const config = JSON.parse(mockRenderOverlay.mock.calls[0][0]);
      expect(config.glyphs).toBe('role');
    });

    it('passes field_color through as a no-op veil (opacity 0) in boardsesh mode', async () => {
      await GET(makeRequest({ ...validParams, render_mode: 'boardsesh', field_color: '#123456' }));
      const config = JSON.parse(mockRenderOverlay.mock.calls[0][0]);
      expect(config.veil).toEqual({ color: '#123456', opacity: 0 });
    });

    it('returns 400 for an invalid render_mode', async () => {
      const response = await GET(makeRequest({ ...validParams, render_mode: 'neon' }));
      expect(response.status).toBe(400);
      expect(mockRenderOverlay).not.toHaveBeenCalled();
    });

    it('returns 400 for an invalid glow_falloff', async () => {
      const response = await GET(makeRequest({ ...validParams, glow_falloff: 'hard' }));
      expect(response.status).toBe(400);
      expect(mockRenderOverlay).not.toHaveBeenCalled();
    });

    it('returns 400 for an invalid field_color', async () => {
      const response = await GET(makeRequest({ ...validParams, field_color: 'blue' }));
      expect(response.status).toBe(400);
      expect(mockRenderOverlay).not.toHaveBeenCalled();
    });
  });

  it.each(['decoy', 'touchstone', 'grasshopper', 'soill'])('accepts %s as a valid board_name', async (board) => {
    const response = await GET(makeRequest({ ...validParams, board_name: board }));
    expect(response.status).toBe(200);
  });

  it('passes thumbnail flag in render config when thumbnail=1', async () => {
    await GET(makeRequest({ ...validParams, thumbnail: '1' }));
    const configJson = mockRenderOverlay.mock.calls[0][0];
    const config = JSON.parse(configJson);
    expect(config.thumbnail).toBe(true);
    expect(config.output_width).toBe(200);
  });

  it('composites backgrounds and returns thumbnail JPEG content for format=jpg', async () => {
    const response = await GET(makeRequest({ ...validParams, thumbnail: '1', include_background: '1', format: 'jpg' }));

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/jpeg');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, s-maxage=31536000, immutable');
    expect(mockComposite).toHaveBeenCalled();
    expect(mockJpegOptions).toHaveBeenCalledWith({
      quality: 85,
      chromaSubsampling: '4:4:4',
      progressive: false,
      optimiseScans: false,
    });
    expect(mockPngOptions).not.toHaveBeenCalled();
    expect(mockWebpOptions).not.toHaveBeenCalled();

    const configJson = mockRenderOverlay.mock.calls[0][0];
    const config = JSON.parse(configJson);
    expect(config.thumbnail).toBe(true);
    expect(config.output_width).toBe(200);
  });

  describe('color_scheme', () => {
    // Kilter is the fixture board here; Woods is the board that actually ships dark art
    // today. What the route owns is the same either way — which filename it hands the
    // pipeline, and that light and dark never share a cache entry — so the fallback branch
    // is driven with existsSync rather than a second board.
    const backgroundParams = { ...validParams, include_background: '1' };

    /** Background files the pipeline actually opened, in order. */
    const openedArtPaths = () =>
      mockSharpDefault.mock.calls.map((call) => call[0]).filter((input): input is string => typeof input === 'string');

    it('opens the light art when the param is absent', async () => {
      await GET(makeRequest(backgroundParams));
      expect(openedArtPaths().some((path) => path.endsWith('.webp'))).toBe(true);
      expect(openedArtPaths().some((path) => path.includes('.dark.webp'))).toBe(false);
    });

    it('opens the dark sibling when asked for it', async () => {
      await GET(makeRequest({ ...backgroundParams, color_scheme: 'dark' }));
      expect(openedArtPaths().some((path) => path.includes('.dark.webp'))).toBe(true);
    });

    it('falls back to the light file for a board that ships no dark art', async () => {
      // Only the light files and the WASM binary are on disk — the state Kilter and Tension
      // are really in. Without the fallback the background layer would resolve to null and
      // the board would come back as an overlay floating on nothing.
      mockExistsSync.mockImplementation((path) => !path.includes('.dark.'));
      await GET(makeRequest({ ...backgroundParams, color_scheme: 'dark' }));

      const opened = openedArtPaths();
      expect(opened.some((path) => path.endsWith('.webp'))).toBe(true);
      expect(opened.some((path) => path.includes('.dark.webp'))).toBe(false);
    });

    it('does not serve the light render out of the byte cache for a dark request', async () => {
      await GET(makeRequest(backgroundParams));
      const afterLight = mockRenderOverlay.mock.calls.length;
      await GET(makeRequest({ ...backgroundParams, color_scheme: 'dark' }));

      expect(mockRenderOverlay.mock.calls.length).toBe(afterLight + 1);
      expect(openedArtPaths().some((path) => path.includes('.dark.webp'))).toBe(true);
    });

    it('treats an explicit light as the default rather than rejecting it', async () => {
      const response = await GET(makeRequest({ ...backgroundParams, color_scheme: 'light' }));
      expect(response.status).toBe(200);
      expect(openedArtPaths().some((path) => path.includes('.dark.webp'))).toBe(false);
    });

    it('returns 400 for a scheme that is neither light nor dark', async () => {
      const response = await GET(makeRequest({ ...backgroundParams, color_scheme: 'sepia' }));
      expect(response.status).toBe(400);
    });
  });

  it('accepts format=jpeg and uses default JPEG options', async () => {
    const response = await GET(makeRequest({ ...validParams, format: 'jpeg' }));

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/jpeg');
    expect(mockJpegOptions).toHaveBeenCalledWith({
      quality: 90,
      chromaSubsampling: '4:4:4',
      mozjpeg: true,
    });
    expect(mockPngOptions).not.toHaveBeenCalled();
    expect(mockWebpOptions).not.toHaveBeenCalled();
  });

  it('returns 400 when frames contains invalid syntax', async () => {
    const response = await GET(makeRequest({ ...validParams, frames: 'p1073r42<script>' }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Invalid frames');
    expect(mockRenderOverlay).not.toHaveBeenCalled();
  });

  it.each([',', 'p1r42,,p2r43', 'p1r42"p2r43', '"'])(
    'returns 400 when frames has malformed segment separators: %s',
    async (frames) => {
      const response = await GET(makeRequest({ ...validParams, frames }));
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('Invalid frames');
      expect(mockRenderOverlay).not.toHaveBeenCalled();
    },
  );

  it('returns 400 when frames exceeds the request cap', async () => {
    const response = await GET(makeRequest({ ...validParams, frames: 'p1r42'.repeat(4097) }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Frames string is too large');
    expect(mockRenderOverlay).not.toHaveBeenCalled();
  });

  it('uses native board width when not thumbnail', async () => {
    await GET(makeRequest(validParams));
    const configJson = mockRenderOverlay.mock.calls[0][0];
    const config = JSON.parse(configJson);
    expect(config.thumbnail).toBe(false);
    expect(config.output_width).toBe(1080);
  });

  it('always sets mirrored to false', async () => {
    await GET(makeRequest(validParams));
    const configJson = mockRenderOverlay.mock.calls[0][0];
    const config = JSON.parse(configJson);
    expect(config.mirrored).toBe(false);
  });

  it('sets stroke_width_multiplier to 1.0 for boards without a render-defaults override', async () => {
    await GET(makeRequest(validParams)); // kilter
    const configJson = mockRenderOverlay.mock.calls[0][0];
    const config = JSON.parse(configJson);
    expect(config.stroke_width_multiplier).toBe(1.0);
  });

  it('issue #2202: prefers the calibrated displayColor over the raw LED color, and boosts Grasshopper stroke width', async () => {
    const { getBoardDetailsForBoard } = await import('@/app/lib/board-utils');
    vi.mocked(getBoardDetailsForBoard).mockReturnValueOnce({
      board_name: 'grasshopper',
      layout_id: 1,
      size_id: 1,
      set_ids: [1],
      boardWidth: 1080,
      boardHeight: 1350,
      holdsData: [{ id: 1, mirroredHoldId: null, cx: 100, cy: 200, r: 20 }],
      images_to_holds: { 'grasshopper-bg.png': [] },
      edge_left: 0,
      edge_right: 11,
      edge_bottom: 0,
      edge_top: 18,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    await GET(
      makeRequest({
        board_name: 'grasshopper',
        layout_id: '1',
        size_id: '1',
        set_ids: '1',
        frames: 'p1r2', // HAND
      }),
    );

    const configJson = mockRenderOverlay.mock.calls[0][0];
    const config = JSON.parse(configJson);
    // Not the raw LED color '#0000FF' — that's far too dark against
    // Grasshopper's busy board photo (issue #2202).
    expect(config.hold_state_map['2'].color).toBe('#4455FF');
    expect(config.stroke_width_multiplier).toBe(1.35);
  });

  it('renders OG variant as PNG on a fixed social canvas', async () => {
    const response = await GET(makeRequest({ ...validParams, variant: 'og', format: 'png', include_background: '1' }));

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(response.headers.get('Cache-Control')).toContain('immutable');
    expect(mockWebpOptions).not.toHaveBeenCalled();

    const configJson = mockRenderOverlay.mock.calls[0][0];
    const config = JSON.parse(configJson);
    expect(config.output_width).toBeLessThan(1080);
    expect(mockPngOptions).toHaveBeenCalled();
  });

  it('passes moonboard renderStyle metadata through to the WASM config', async () => {
    const { getBoardDetailsForBoard } = await import('@/app/lib/board-utils');
    vi.mocked(getBoardDetailsForBoard).mockReturnValueOnce({
      board_name: 'moonboard',
      layout_id: 3,
      size_id: 1,
      set_ids: [5, 6],
      boardWidth: 650,
      boardHeight: 1000,
      holdsData: [{ id: 1, mirroredHoldId: null, cx: 100, cy: 200, r: 20 }],
      images_to_holds: { 'moonboard-bg.png': [] },
      edge_left: 0,
      edge_right: 11,
      edge_bottom: 0,
      edge_top: 18,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    await GET(
      makeRequest({
        board_name: 'moonboard',
        layout_id: '3',
        size_id: '1',
        set_ids: '5,6',
        frames: 'p1r46',
      }),
    );

    const configJson = mockRenderOverlay.mock.calls[0][0];
    const config = JSON.parse(configJson);
    expect(config.hold_state_map['46']).toEqual({
      color: '#FFE066',
      renderStyle: 'above-marker',
    });
  });

  it('returns 500 when render throws', async () => {
    mockRenderOverlay.mockImplementationOnce(() => {
      throw new Error('render exploded');
    });
    const response = await GET(makeRequest(validParams));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toContain('render exploded');
  });

  it('calls composite with background when include_background=1', async () => {
    const response = await GET(makeRequest({ ...validParams, thumbnail: '1', include_background: '1' }));
    expect(response.status).toBe(200);
    // composite() should have been called (background + overlay layers)
    expect(mockComposite).toHaveBeenCalled();
    // Thumbnail responses should use lower-size lossy WebP options
    expect(mockWebpOptions).toHaveBeenCalledWith({ quality: 60, alphaQuality: 70, effort: 4 });
  });

  it('does not call composite without include_background', async () => {
    const response = await GET(makeRequest(validParams));
    expect(response.status).toBe(200);
    expect(mockComposite).not.toHaveBeenCalled();
    expect(mockWebpOptions).toHaveBeenCalledWith({ lossless: true });
  });

  it('composites a full-bleed black scrim into the base when dim_background is set', async () => {
    const response = await GET(
      makeRequest({ ...validParams, thumbnail: '1', include_background: '1', dim_background: '0.18' }),
    );
    expect(response.status).toBe(200);

    // Two composites onto the cached base: the scrim, then the holds overlay.
    // The scrim must be a real layer — scaling RGB instead would leave the
    // transparent parts of the board photo undimmed (see pipeline.ts).
    expect(mockComposite).toHaveBeenCalledTimes(2);
    expect(mockLinear).not.toHaveBeenCalled();

    const scrimLayers = mockComposite.mock.calls[0][0] as Array<{
      input?: { create?: { channels?: number; background?: { r?: number; alpha?: number } } };
    }>;
    expect(scrimLayers).toHaveLength(1);
    expect(scrimLayers[0].input?.create?.background).toEqual({ r: 0, g: 0, b: 0, alpha: 0.18 });
    expect(scrimLayers[0].input?.create?.channels).toBe(4);

    const overlayLayers = mockComposite.mock.calls[1][0] as unknown[];
    expect(overlayLayers).toHaveLength(1);
  });

  it('does not dim when dim_background is absent', async () => {
    const response = await GET(makeRequest({ ...validParams, thumbnail: '1', include_background: '1' }));
    expect(response.status).toBe(200);
    expect(mockLinear).not.toHaveBeenCalled();
    expect(mockComposite).toHaveBeenCalledTimes(1);
    // composite array is [holds overlay] only — no scrim.
    const layers = mockComposite.mock.calls[0][0] as Array<{ input?: { create?: unknown } }>;
    expect(layers).toHaveLength(1);
    expect(layers[0].input).not.toHaveProperty('create');
  });

  it('returns 400 when dim_background is out of range', async () => {
    const response = await GET(makeRequest({ ...validParams, dim_background: '1.5' }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('dim_background');
  });

  it('ignores dim_background without include_background (overlay-only, no composite)', async () => {
    const response = await GET(makeRequest({ ...validParams, dim_background: '0.18' }));
    expect(response.status).toBe(200);
    expect(mockComposite).not.toHaveBeenCalled();
  });

  it('falls back to lossless when background images are missing', async () => {
    // Make findPublicImagePath return null for all candidates
    mockExistsSync.mockImplementation((path) => path.includes('.wasm'));
    const response = await GET(makeRequest({ ...validParams, include_background: '1' }));
    expect(response.status).toBe(200);
    // Should fall back to lossless since no backgrounds found
    expect(mockComposite).not.toHaveBeenCalled();
    expect(mockWebpOptions).toHaveBeenCalledWith({ lossless: true });
  });

  it('composites successfully when some background images fail to load', async () => {
    // Override board details to return multiple background image keys
    const { getBoardDetailsForBoard } = await import('@/app/lib/board-utils');
    vi.mocked(getBoardDetailsForBoard).mockReturnValueOnce({
      board_name: 'kilter',
      layout_id: 1,
      size_id: 7,
      set_ids: [1, 20],
      boardWidth: 1080,
      boardHeight: 1350,
      holdsData: [{ id: 1073, mirroredHoldId: null, cx: 200, cy: 300, r: 20 }],
      images_to_holds: {
        'layer-good.png': [],
        'layer-bad.png': [],
        'layer-also-good.png': [],
      },
      edge_left: 0,
      edge_right: 144,
      edge_bottom: 0,
      edge_top: 180,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    // The middle layer's decode rejects; the other two must still land.
    failingInputPaths.push('layer-bad');

    const response = await GET(makeRequest({ ...validParams, include_background: '1' }));
    expect(response.status).toBe(200);
    // Two surviving layers fold into the base (1 composite) + the overlay (1).
    expect(mockComposite).toHaveBeenCalledTimes(2);
    // Should use lossy WebP (composited output) not lossless (fallback)
    expect(mockWebpOptions).toHaveBeenCalledWith({ quality: 80 });
  });

  it('serves an identical repeat request from the byte cache without re-rendering', async () => {
    const params = { ...validParams, include_background: '1' };

    const first = await GET(makeRequest(params));
    expect(first.status).toBe(200);
    expect(mockRenderOverlay).toHaveBeenCalledTimes(1);
    const firstBytes = new Uint8Array(await first.arrayBuffer());

    const second = await GET(makeRequest(params));
    expect(second.status).toBe(200);
    // No second WASM render, no second sharp pipeline.
    expect(mockRenderOverlay).toHaveBeenCalledTimes(1);
    expect(second.headers.get('Server-Timing')).toContain('cache;desc=hit');
    expect(second.headers.get('Content-Type')).toBe(first.headers.get('Content-Type'));
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(firstBytes);
  });

  it('reports cache;desc=none for an overlay-only render', async () => {
    // No background means no base to cache — reporting it as a `miss` would
    // read as a cache the route keeps failing to fill.
    const response = await GET(makeRequest(validParams));

    expect(response.status).toBe(200);
    expect(response.headers.get('Server-Timing')).toContain('cache;desc=none');
  });

  it('reports a board-base cache hit once the board photos are composed', async () => {
    await GET(makeRequest({ ...validParams, include_background: '1' }));
    // Same board, different climb — the base is reused, the overlay is not.
    const response = await GET(makeRequest({ ...validParams, include_background: '1', frames: 'p1073r44' }));

    expect(response.status).toBe(200);
    expect(mockRenderOverlay).toHaveBeenCalledTimes(2);
    expect(response.headers.get('Server-Timing')).toContain('cache;desc=base-hit');
  });

  it('coalesces concurrent identical requests into a single render', async () => {
    const params = { ...validParams, include_background: '1' };

    const [first, second] = await Promise.all([GET(makeRequest(params)), GET(makeRequest(params))]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(mockRenderOverlay).toHaveBeenCalledTimes(1);
  });

  // Every param that changes a pixel has to be in the byte-cache key. Drop one
  // and the second request of its pair is served the first one's bytes — so
  // each case asserts a genuine second render, not just a 200.
  it.each([
    // label, params both requests share, the one param that differs, whether
    // the mocked encoder can show the difference in the response body.
    ['board_name', {}, { board_name: 'tension' }, false],
    ['layout_id', {}, { layout_id: '8' }, false],
    ['size_id', {}, { size_id: '17' }, false],
    ['set_ids', {}, { set_ids: '1,27' }, false],
    ['frames', {}, { frames: 'p1073r44' }, false],
    ['format', {}, { format: 'png' }, true],
    ['thumbnail', {}, { thumbnail: '1' }, true],
    ['include_background', {}, { include_background: '0' }, true],
    ['dim_background', {}, { dim_background: '0.18' }, false],
    ['variant', { format: 'png' }, { variant: 'og' }, false],
    // issue #2202: a boardsesh render must never be served under a classic
    // key, and within boardsesh mode every option that moves a pixel is in
    // the key. (Classic ignores the other three, so they are keyed only once
    // render_mode=boardsesh — see the collapse test below.)
    ['render_mode', {}, { render_mode: 'boardsesh' }, false],
    ['glow_falloff', { render_mode: 'boardsesh' }, { glow_falloff: 'plateau' }, false],
    ['glyphs', { render_mode: 'boardsesh' }, { glyphs: '1' }, false],
    ['field_color', { render_mode: 'boardsesh' }, { field_color: '#123456' }, false],
  ] as Array<[string, Record<string, string>, Record<string, string>, boolean]>)(
    'keys the byte cache on %s',
    async (_label, shared, override, expectDistinctBody) => {
      const params = { ...validParams, include_background: '1', ...shared };

      const first = await GET(makeRequest(params));
      expect(first.status).toBe(200);
      expect(mockRenderOverlay).toHaveBeenCalledTimes(1);
      const firstBytes = Buffer.from(await first.arrayBuffer());

      const second = await GET(makeRequest({ ...params, ...override }));
      expect(second.status).toBe(200);
      // A key missing this param would have served the cached bytes instead.
      expect(mockRenderOverlay).toHaveBeenCalledTimes(2);
      expect(second.headers.get('Server-Timing')).not.toContain('cache;desc=hit');

      if (expectDistinctBody) {
        const secondBytes = Buffer.from(await second.arrayBuffer());
        const differs =
          !secondBytes.equals(firstBytes) || second.headers.get('Content-Type') !== first.headers.get('Content-Type');
        expect(differs).toBe(true);
      }
    },
  );

  it.each([
    ['glow_falloff', { glow_falloff: 'plateau' }],
    ['glyphs', { glyphs: '1' }],
    ['field_color', { field_color: '#123456' }],
  ] as Array<[string, Record<string, string>]>)(
    'does not fragment the classic byte cache on %s, which classic ignores',
    async (_label, override) => {
      const params = { ...validParams, include_background: '1' };
      const first = await GET(makeRequest(params));
      expect(first.status).toBe(200);
      expect(mockRenderOverlay).toHaveBeenCalledTimes(1);

      const second = await GET(makeRequest({ ...params, ...override }));
      expect(second.status).toBe(200);
      expect(mockRenderOverlay).toHaveBeenCalledTimes(1);
      expect(second.headers.get('Server-Timing')).toContain('cache;desc=hit');
    },
  );

  it('serves cached bytes for a param the renderer never reads', async () => {
    const params = { ...validParams, include_background: '1' };

    await GET(makeRequest(params));
    expect(mockRenderOverlay).toHaveBeenCalledTimes(1);

    // `angle` is a board-config param elsewhere in the app, but this route
    // never reads it and nothing angle-shaped reaches the WASM config — so the
    // cached bytes are the right answer for it. The day angle (or any new
    // param) starts changing pixels, this test goes red and the param belongs
    // in the byte key above, not in this exclusion.
    const second = await GET(makeRequest({ ...params, angle: '40' }));

    expect(second.status).toBe(200);
    expect(mockRenderOverlay).toHaveBeenCalledTimes(1);
    expect(second.headers.get('Server-Timing')).toContain('cache;desc=hit');
  });

  it('never runs more renders at once than the concurrency limit', async () => {
    const closeGate = openRenderGate();

    const inFlight = ['p2001r42', 'p2002r42', 'p2003r42'].map((frames) =>
      GET(makeRequest({ ...validParams, include_background: '1', frames })),
    );
    // Everything that can start has started; the rest are queued on the semaphore.
    await flush();
    expect(peakActiveRenders).toBe(1);

    closeGate();
    const responses = await Promise.all(inFlight);

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(mockRenderOverlay).toHaveBeenCalledTimes(3);
    // Held across the whole drain, not just the first moment.
    expect(peakActiveRenders).toBe(1);
    expect(activeRenders).toBe(0);
  });

  it('sheds with 503 + Retry-After once the render queue is saturated', async () => {
    const closeGate = openRenderGate();

    // One render holds the single slot; the next 41 queue up. The 43rd arrives
    // to a queue past the ceiling and is shed rather than made to wait.
    const queued = Array.from({ length: 42 }, (_unused, index) =>
      GET(makeRequest({ ...validParams, frames: `p${3000 + index}r42` })),
    );
    await flush();

    const shed = await GET(makeRequest({ ...validParams, frames: 'p3999r42' }));

    expect(shed.status).toBe(503);
    expect(shed.headers.get('Retry-After')).toBe('5');
    expect(shed.headers.get('Cache-Control')).toBe('no-store');
    const body = await shed.json();
    expect(body.error).toContain('saturated');

    closeGate();
    const drained = await Promise.all(queued);
    expect(drained.every((response) => response.status === 200)).toBe(true);
    // The shed request never rendered; the 42 that queued all did.
    expect(mockRenderOverlay).toHaveBeenCalledTimes(42);
  });

  it('does not shed a request that can join an in-flight render', async () => {
    const closeGate = openRenderGate();

    const params = { ...validParams, frames: 'p4242r42' };
    const queued = [
      GET(makeRequest(params)),
      ...Array.from({ length: 41 }, (_unused, index) =>
        GET(makeRequest({ ...validParams, frames: `p${4300 + index}r42` })),
      ),
    ];
    await flush();

    // Same bytes as the render already in flight: it costs nothing to serve, so
    // it must not be shed even with the queue over the ceiling.
    const coalescedPromise = GET(makeRequest(params));
    closeGate();

    const coalesced = await coalescedPromise;
    expect(coalesced.status).toBe(200);

    await Promise.all(queued);
    // 42 renders for 43 requests — the coalesced one paid for nothing.
    expect(mockRenderOverlay).toHaveBeenCalledTimes(42);
  });

  it('reports the queue wait in Server-Timing', async () => {
    const response = await GET(makeRequest({ ...validParams, include_background: '1' }));
    expect(response.headers.get('Server-Timing')).toMatch(/queue;dur=\d/);
  });

  it('returns 400 when the requested render exceeds the pixel ceiling', async () => {
    const { getBoardDetailsForBoard } = await import('@/app/lib/board-utils');
    vi.mocked(getBoardDetailsForBoard).mockReturnValueOnce({
      board_name: 'kilter',
      layout_id: 1,
      size_id: 7,
      set_ids: [1, 20],
      boardWidth: 2000,
      boardHeight: 3000,
      holdsData: [{ id: 1073, mirroredHoldId: null, cx: 200, cy: 300, r: 20 }],
      images_to_holds: { 'huge.png': [] },
      edge_left: 0,
      edge_right: 144,
      edge_bottom: 0,
      edge_top: 180,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const response = await GET(makeRequest(validParams));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('3000000');
    // Nothing is rendered or allocated for an oversized request.
    expect(mockRenderOverlay).not.toHaveBeenCalled();
    expect(mockSharpDefault).not.toHaveBeenCalled();
  });

  it('still renders a board at the largest real size', async () => {
    const { getBoardDetailsForBoard } = await import('@/app/lib/board-utils');
    vi.mocked(getBoardDetailsForBoard).mockReturnValueOnce({
      board_name: 'kilter',
      layout_id: 5,
      size_id: 15,
      set_ids: [24],
      // Kilter's tallest board: 1080×2498 ≈ 2.70 MP, just under the ceiling.
      boardWidth: 1080,
      boardHeight: 2498,
      holdsData: [{ id: 1073, mirroredHoldId: null, cx: 200, cy: 300, r: 20 }],
      images_to_holds: { 'tall.png': [] },
      edge_left: 0,
      edge_right: 144,
      edge_bottom: 0,
      edge_top: 180,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const response = await GET(makeRequest({ ...validParams, layout_id: '5', size_id: '15', set_ids: '24' }));
    expect(response.status).toBe(200);
  });

  // #4773: the route used to hard-code `version: 'immutable'`, which claimed a
  // year of cache lifetime for a URL that did not identify its bytes.
  describe('cache version', () => {
    const lastHeaderCall = () => {
      const calls = vi.mocked(createOgImageHeaders).mock.calls;
      return calls[calls.length - 1][0];
    };

    it('passes a well-formed v through as the cache version', async () => {
      const response = await GET(makeRequest({ ...validParams, v: 'ddff19e91ac6' }));
      expect(response.status).toBe(200);
      expect(lastHeaderCall()).toMatchObject({ version: 'ddff19e91ac6', unversionedTier: 'daily' });
    });

    it('treats a missing v as unversioned on the daily tier', async () => {
      const response = await GET(makeRequest(validParams));
      expect(response.status).toBe(200);
      expect(lastHeaderCall()).toMatchObject({ version: null, unversionedTier: 'daily' });
    });

    it.each([
      ['a path traversal attempt', '../../etc/passwd'],
      ['non-hex characters', 'ZZZZZZZZ'],
      ['too short to be a digest', 'abc'],
      ['absurdly long', 'a'.repeat(500)],
      ['the empty string', ''],
    ])('rejects %s as a version without failing the request', async (_label, versionParam) => {
      const response = await GET(makeRequest({ ...validParams, v: versionParam }));
      expect(response.status).toBe(200);
      expect(lastHeaderCall()).toMatchObject({ version: null });
    });

    it('does not fragment the byte cache on v', async () => {
      // Two requests for the same pixels during a rolling deploy carry different
      // versions. One process only ever runs one renderer, so the second must be
      // a byte-cache hit rather than a second WASM + sharp pass.
      await GET(makeRequest({ ...validParams, v: 'aaaaaaaaaaaa' }));
      const second = await GET(makeRequest({ ...validParams, v: 'bbbbbbbbbbbb' }));
      expect(second.headers.get('Server-Timing')).toContain('cache;desc=hit');
      expect(lastHeaderCall()).toMatchObject({ version: 'bbbbbbbbbbbb' });
    });

    it('still renders an unknown param it does not recognise', async () => {
      // embedded/projects/moonboard-dev-server already ships `revision=<n>` to
      // production. Unknown params must stay inert, not 400.
      const response = await GET(makeRequest({ ...validParams, revision: '7' }));
      expect(response.status).toBe(200);
      expect(lastHeaderCall()).toMatchObject({ version: null });
    });
  });
});
