// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MARKER_RENDERER_UNAVAILABLE_MESSAGE,
  renderHoldsOverlay,
  _webRendererForTests,
} from '../../../modules/board-renderer/src/index.web';

function renderBytes(width: number, height: number, payloadLength = width * height * 4): Uint8Array {
  const bytes = new Uint8Array(8 + payloadLength);
  const header = new DataView(bytes.buffer);
  header.setUint32(0, width, true);
  header.setUint32(4, height, true);
  return bytes;
}

afterEach(() => {
  window.history.replaceState({}, '', '/');
  _webRendererForTests.renderedObjectUrls.clear();
  vi.restoreAllMocks();
});

describe('web board renderer', () => {
  it('resolves static WASM files under the /app base path from a deep link', () => {
    window.history.replaceState({}, '', '/app/climbs/kilter');
    expect(_webRendererForTests.resolveWasmAssetUrl('board_renderer_wasm_bg.wasm')).toBe(
      `${window.location.origin}/app/wasm/board_renderer_wasm_bg.wasm`,
    );
  });

  it('normalizes an Expo base element without a trailing slash', () => {
    const base = document.createElement('base');
    base.setAttribute('href', '/app');
    document.head.append(base);
    try {
      expect(_webRendererForTests.resolveWasmAssetUrl('board_renderer_wasm.js')).toBe(
        `${window.location.origin}/app/wasm/board_renderer_wasm.js`,
      );
    } finally {
      base.remove();
    }
  });

  it('decodes a complete RGBA response', () => {
    const decoded = _webRendererForTests.decodeRenderOutput(renderBytes(2, 3));
    expect(decoded.width).toBe(2);
    expect(decoded.height).toBe(3);
    expect(decoded.rgba).toHaveLength(24);
  });

  it('rejects truncated headers, invalid dimensions, and mismatched payloads', () => {
    expect(() => _webRendererForTests.decodeRenderOutput(new Uint8Array(7))).toThrow('truncated image header');
    expect(() => _webRendererForTests.decodeRenderOutput(renderBytes(0, 2, 0))).toThrow('invalid dimensions');
    expect(() => _webRendererForTests.decodeRenderOutput(renderBytes(2, 2, 4))).toThrow('expected 24');
  });

  // Issues #4240 and #4495: this module used to refuse shape and marker-size
  // overrides because the committed WASM predated them, which blanked every
  // overlay the moment anyone touched the accessibility settings. Brush
  // thickness was exempted in #4240 for the same reason (Grasshopper's 1.35
  // board default would have blanked it with no user override at all). The pkg
  // is now rebuilt and honours all three — proven against the committed binary
  // in board-renderer-wasm-runtime.test.ts — so no config may be refused again.
  //
  // jsdom cannot instantiate the WASM glue, so every render here fails; what
  // this asserts is HOW it fails: on the render, never on a capability refusal.
  it('never refuses a marker override before it reaches the renderer', async () => {
    const markerConfigs: Array<[string, Record<string, unknown>]> = [
      ['marker-size-key', { shape_size_multiplier: 1.5 }],
      ['marker-shape-key', { hold_state_map: { 2: { color: '#4455FF', shape: 'triangle-up' } } }],
      ['marker-brush-key', { stroke_width_multiplier: 1.35 }],
    ];

    for (const [cacheKey, overrides] of markerConfigs) {
      const failure = await renderHoldsOverlay(
        JSON.stringify({ hold_state_map: {}, holds: [], frames: '', ...overrides }),
        cacheKey,
      ).then(
        () => null,
        (error: unknown) => error,
      );
      expect(String(failure)).not.toContain(MARKER_RENDERER_UNAVAILABLE_MESSAGE);
    }
  });

  it('revokes every owned object URL during cleanup', () => {
    const revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectUrl });
    _webRendererForTests.renderedObjectUrls.set('first', 'blob:first');
    _webRendererForTests.renderedObjectUrls.set('second', 'blob:second');

    _webRendererForTests.releaseAllObjectUrls();

    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:first');
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:second');
    expect(_webRendererForTests.renderedObjectUrls.size).toBe(0);
  });

  it('does not revoke a URL that a mounted overlay may still reference', () => {
    const revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectUrl });
    for (let entryIndex = 0; entryIndex < 512; entryIndex++) {
      _webRendererForTests.rememberObjectUrl(`key-${entryIndex}`, `blob:${entryIndex}`);
    }

    _webRendererForTests.rememberObjectUrl('key-512', 'blob:512');

    expect(_webRendererForTests.renderedObjectUrls.size).toBe(513);
    expect(_webRendererForTests.renderedObjectUrls.has('key-0')).toBe(true);
    expect(revokeObjectUrl).not.toHaveBeenCalled();
  });
});
