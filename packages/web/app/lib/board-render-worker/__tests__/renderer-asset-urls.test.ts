import { describe, expect, it } from 'vitest';
import { BOARD_RENDERER_ASSET_OBJECT_KEYS } from '@boardsesh/static-assets/renderer';
import { getBoardRendererAssetUrls } from '../renderer-asset-urls';

describe('board renderer asset URLs', () => {
  it('keeps unpublished local and preview assets on the worker origin', () => {
    expect(getBoardRendererAssetUrls('https://preview.boardsesh.test', '')).toEqual({
      glueUrl: 'https://preview.boardsesh.test/wasm/board_renderer_wasm.js',
      wasmUrl: 'https://preview.boardsesh.test/wasm/board_renderer_wasm_bg.wasm',
    });
  });

  it('loads both immutable files from one production catalog and CDN origin', () => {
    const urls = getBoardRendererAssetUrls('https://www.boardsesh.com', 'https://assets.boardsesh.com/');
    expect(urls).toEqual({
      glueUrl: `https://assets.boardsesh.com/${BOARD_RENDERER_ASSET_OBJECT_KEYS['/wasm/board_renderer_wasm.js']}`,
      wasmUrl: `https://assets.boardsesh.com/${BOARD_RENDERER_ASSET_OBJECT_KEYS['/wasm/board_renderer_wasm_bg.wasm']}`,
    });
    expect(urls.glueUrl).toMatch(/\/static\/v1\/[a-f0-9]{64}\.js$/);
    expect(urls.wasmUrl).toMatch(/\/static\/v1\/[a-f0-9]{64}\.wasm$/);
  });
});
