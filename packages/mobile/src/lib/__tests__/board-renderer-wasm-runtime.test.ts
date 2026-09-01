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

/**
 * Sum of every pixel's alpha channel. `soft` and `plateau` glow falloff reach
 * the same outer radius (measured: opaquePixelCount is identical to within
 * antialiasing noise between the two), so `opaquePixelCount` can't see the
 * difference — it's the falloff *shape* inside that radius (plateau holds
 * near-max alpha longer before dropping) that differs, which only shows up
 * in the total alpha weight.
 */
function alphaWeight(config: Record<string, unknown>): number {
  const { rgba } = _webRendererForTests.decodeRenderOutput(renderOverlay(JSON.stringify(config)));
  let sum = 0;
  for (let pixelOffset = 3; pixelOffset < rgba.length; pixelOffset += 4) {
    sum += rgba[pixelOffset];
  }
  return sum;
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

  // Issue #2202. `render_mode` is the same stale-artifact hazard one level up:
  // every Boardsesh field is `#[serde(default)]` on a struct with no
  // `deny_unknown_fields`, so an artifact predating the mode takes the config,
  // drops it whole, and hands back a classic drawing. This asks the committed
  // binary the exact question probeBoardseshRendererSupport asks the native
  // library at runtime — same 8x8 config, same opaque white veil, same
  // "did the two modes draw different things" comparison.
  describe('implements the Boardsesh render mode', () => {
    const PROBE_CONFIG_BASE = {
      board_width: 8,
      board_height: 8,
      output_width: 8,
      frames: '',
      thumbnail: false,
      holds: [],
      hold_state_map: {},
    };

    it('draws the veil in boardsesh mode and nothing in classic mode', async () => {
      await initCommittedWasm();

      const classicOutput = renderOverlay(JSON.stringify({ ...PROBE_CONFIG_BASE, render_mode: 'classic' }));
      const boardseshOutput = renderOverlay(
        JSON.stringify({
          ...PROBE_CONFIG_BASE,
          render_mode: 'boardsesh',
          veil: { color: '#FFFFFF', opacity: 1 },
        }),
      );

      // The probe's own test: different bytes means the mode is real.
      expect(Buffer.from(boardseshOutput).equals(Buffer.from(classicOutput))).toBe(false);

      // And the specific answer behind that difference, so a merely-different
      // artifact can't pass: classic paints an empty transparent pixmap, while
      // the veil fills all 64 pixels opaque white (no lit silhouettes to punch
      // out of it).
      const classic = _webRendererForTests.decodeRenderOutput(classicOutput);
      const boardsesh = _webRendererForTests.decodeRenderOutput(boardseshOutput);
      expect(Array.from(classic.rgba).every((channel) => channel === 0)).toBe(true);
      expect(Array.from(boardsesh.rgba).every((channel) => channel === 255)).toBe(true);
    });

    it('degrades an unrecognised render mode to classic rather than failing the parse', async () => {
      await initCommittedWasm();

      // `#[serde(other)]` on BoardRenderMode — a newer JS bundle naming a mode
      // this binary has never heard of must still render, as classic.
      const unknownMode = renderOverlay(JSON.stringify({ ...PROBE_CONFIG_BASE, render_mode: 'holographic' }));
      const classic = renderOverlay(JSON.stringify({ ...PROBE_CONFIG_BASE, render_mode: 'classic' }));
      expect(Buffer.from(unknownMode).equals(Buffer.from(classic))).toBe(true);
    });
  });

  // Issue #2202: the "boardsesh" render mode (veil + glow on traced hold
  // silhouettes) is new Rust-core surface. As of this test the committed
  // wasm artifact has already been rebuilt with it, so these currently pass —
  // but keep them un-skipped: the next time this artifact drifts behind the
  // Rust core (issue #4495's exact failure mode), a red here is the only
  // signal, and the wasm rebuild + re-sync is
  // packages/mobile/public/wasm/README.md's job, not this test's.
  describe('boardsesh render mode', () => {
    const BOARDSESH_SQUARE_HOLD_CONFIG = {
      ...KNOWN_RENDER_CONFIG,
      render_mode: 'boardsesh',
      holds: KNOWN_RENDER_CONFIG.holds.map((hold) =>
        hold.id === 1 ? { ...hold, outline: [-1, -1, 1, -1, 1, 1, -1, 1] } : hold,
      ),
    };

    it('renders a different opaque-pixel count in boardsesh mode with a traced outline hold', async () => {
      await initCommittedWasm();

      const classicCount = opaquePixelCount(KNOWN_RENDER_CONFIG);
      const boardseshCount = opaquePixelCount(BOARDSESH_SQUARE_HOLD_CONFIG);
      expect(boardseshCount).not.toBe(classicCount);
    });

    it('renders a different total alpha weight for plateau glow falloff than soft', async () => {
      await initCommittedWasm();

      // opaquePixelCount is the wrong metric here: soft and plateau reach the
      // same outer radius, so the alpha>0 pixel count barely moves. The two
      // falloffs differ in *how quickly* alpha drops off inside that radius
      // (plateau holds near-max longer), which shows up as total alpha weight.
      const soft = alphaWeight({ ...BOARDSESH_SQUARE_HOLD_CONFIG, glow_falloff: 'soft' });
      const plateau = alphaWeight({ ...BOARDSESH_SQUARE_HOLD_CONFIG, glow_falloff: 'plateau' });
      expect(plateau).not.toBe(soft);
    });

    it('raises the opaque-pixel count when a veil is applied', async () => {
      await initCommittedWasm();

      const withoutVeil = opaquePixelCount(BOARDSESH_SQUARE_HOLD_CONFIG);
      const withVeil = opaquePixelCount({
        ...BOARDSESH_SQUARE_HOLD_CONFIG,
        veil: { color: '#181225', opacity: 0.6 },
      });
      expect(withVeil).toBeGreaterThan(withoutVeil);
    });
  });
});
