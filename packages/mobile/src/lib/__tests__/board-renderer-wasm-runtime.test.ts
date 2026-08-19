import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import initWasm, { render_overlay as renderOverlay } from '../../../../board-renderer/wasm/pkg/board_renderer_wasm';
import { _webRendererForTests } from '../../../modules/board-renderer/src/index.web';

const PUBLIC_GLUE_URL = new URL('../../../public/wasm/board_renderer_wasm.js', import.meta.url);
const PUBLIC_WASM_URL = new URL('../../../public/wasm/board_renderer_wasm_bg.wasm', import.meta.url);
const SOURCE_GLUE_URL = new URL('../../../../board-renderer/wasm/pkg/board_renderer_wasm.js', import.meta.url);

const KNOWN_RENDER_CONFIG = {
  board_width: 1080,
  board_height: 1350,
  output_width: 300,
  frames: 'p1r42p2r43p3r44',
  mirrored: false,
  thumbnail: false,
  holds: [
    { id: 1, mirroredHoldId: null, cx: 200, cy: 300, r: 20 },
    { id: 2, mirroredHoldId: null, cx: 500, cy: 600, r: 20 },
    { id: 3, mirroredHoldId: null, cx: 800, cy: 900, r: 20 },
  ],
  hold_state_map: {
    42: { color: '#00FF00' },
    43: { color: '#00FFFF' },
    44: { color: '#FF00FF' },
  },
};

/** Opaque (alpha > 0) pixels in a render — the cheapest proxy for "the geometry changed". */
function opaquePixelCount(config: Record<string, unknown>): number {
  const { rgba } = _webRendererForTests.decodeRenderOutput(renderOverlay(JSON.stringify(config)));
  let opaque = 0;
  for (let pixelOffset = 3; pixelOffset < rgba.length; pixelOffset += 4) {
    if (rgba[pixelOffset] !== 0) opaque += 1;
  }
  return opaque;
}

/** KNOWN_RENDER_CONFIG with the same marker `shape` stamped on every hold state. */
function withHoldShape(shape: string): Record<string, unknown> {
  return {
    ...KNOWN_RENDER_CONFIG,
    hold_state_map: Object.fromEntries(
      Object.entries(KNOWN_RENDER_CONFIG.hold_state_map).map(([code, stateInfo]) => [code, { ...stateInfo, shape }]),
    ),
  };
}

let wasmReady: Promise<void> | null = null;
function initCommittedWasm(): Promise<void> {
  wasmReady ??= (async () => {
    const publicWasm = await readFile(PUBLIC_WASM_URL);
    await initWasm({ module_or_path: new WebAssembly.Module(Uint8Array.from(publicWasm)) });
  })();
  return wasmReady;
}

describe('committed web board renderer WASM', () => {
  it('renders a known climb into correctly-sized, nonblank RGBA pixels', async () => {
    const [publicGlue, sourceGlue] = await Promise.all([readFile(PUBLIC_GLUE_URL), readFile(SOURCE_GLUE_URL)]);

    // The browser loads the public copy. Prove the glue exercised by this test
    // is byte-for-byte the same committed module that Expo serves.
    expect(publicGlue.equals(sourceGlue)).toBe(true);

    await initCommittedWasm();

    const output = renderOverlay(JSON.stringify(KNOWN_RENDER_CONFIG));
    const { width, height, rgba } = _webRendererForTests.decodeRenderOutput(output);

    expect({ width, height }).toEqual({ width: 300, height: 375 });
    expect(rgba).toHaveLength(width * height * 4);

    let coloredPixelCount = 0;
    let transparentPixelCount = 0;
    let hasExpectedGreen = false;
    for (let pixelOffset = 0; pixelOffset < rgba.length; pixelOffset += 4) {
      const red = rgba[pixelOffset];
      const green = rgba[pixelOffset + 1];
      const blue = rgba[pixelOffset + 2];
      const alpha = rgba[pixelOffset + 3];
      if (alpha === 0) {
        transparentPixelCount += 1;
      } else {
        coloredPixelCount += 1;
        hasExpectedGreen ||= green > red && green > blue;
      }
    }

    expect(coloredPixelCount).toBeGreaterThan(0);
    expect(transparentPixelCount).toBeGreaterThan(0);
    expect(hasExpectedGreen).toBe(true);
  });

  // Issue #4495: the committed artifact sat three commits behind the Rust core
  // for months. It predated stroke_width_multiplier, shape_size_multiplier and
  // per-hold `shape`, and because RenderConfig has no `deny_unknown_fields`,
  // serde dropped all three without a murmur — every one of these configs
  // rendered an identical 273 opaque pixels. CI has no Rust toolchain and
  // cannot rebuild the binary, so these assertions are the only thing standing
  // between a stale artifact and a silently blank wall.
  describe('honours every marker field the Rust core supports', () => {
    it('draws a thinner outline for a low stroke multiplier and a thicker one for a high multiplier', async () => {
      await initCommittedWasm();
      const atDefault = opaquePixelCount(KNOWN_RENDER_CONFIG);

      expect(opaquePixelCount({ ...KNOWN_RENDER_CONFIG, stroke_width_multiplier: 0.5 })).toBeLessThan(atDefault);
      expect(opaquePixelCount({ ...KNOWN_RENDER_CONFIG, stroke_width_multiplier: 2 })).toBeGreaterThan(atDefault);
    });

    it('draws bigger markers for a larger shape-size multiplier', async () => {
      await initCommittedWasm();

      expect(opaquePixelCount({ ...KNOWN_RENDER_CONFIG, shape_size_multiplier: 2 })).toBeGreaterThan(
        opaquePixelCount(KNOWN_RENDER_CONFIG),
      );
    });

    it('draws each marker shape distinctly, with circle matching the default', async () => {
      await initCommittedWasm();
      const atDefault = opaquePixelCount(KNOWN_RENDER_CONFIG);

      // An explicit `circle` is the serde default, so it must not move a pixel.
      expect(opaquePixelCount(withHoldShape('circle'))).toBe(atDefault);
      for (const shape of ['square', 'triangle-up', 'triangle-down', 'diamond', 'octagon']) {
        expect(opaquePixelCount(withHoldShape(shape))).not.toBe(atDefault);
      }
    });

    it('degrades an unrecognised shape to a circle rather than failing the parse', async () => {
      await initCommittedWasm();

      // `#[serde(other)]` on HoldMarkerShape — a newer JS bundle naming a shape
      // this binary has never heard of must still render.
      expect(opaquePixelCount(withHoldShape('pentagram'))).toBe(opaquePixelCount(KNOWN_RENDER_CONFIG));
    });
  });
});
