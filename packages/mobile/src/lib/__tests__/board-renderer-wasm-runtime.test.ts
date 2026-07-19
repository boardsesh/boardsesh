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

describe('committed web board renderer WASM', () => {
  it('renders a known climb into correctly-sized, nonblank RGBA pixels', async () => {
    const [publicGlue, sourceGlue, publicWasm] = await Promise.all([
      readFile(PUBLIC_GLUE_URL),
      readFile(SOURCE_GLUE_URL),
      readFile(PUBLIC_WASM_URL),
    ]);

    // The browser loads the public copy. Prove the glue exercised by this test
    // is byte-for-byte the same committed module that Expo serves.
    expect(publicGlue.equals(sourceGlue)).toBe(true);

    const wasmBytes = Uint8Array.from(publicWasm);
    await initWasm({ module_or_path: new WebAssembly.Module(wasmBytes) });

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
});
