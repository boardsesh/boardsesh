import { BOARD_RENDERER_ASSET_OBJECT_KEYS } from '@boardsesh/static-assets/renderer';

/** Resolve both files from the same generated catalog, with local assets for unpublished previews. */
export function getBoardRendererAssetUrls(
  origin: string,
  baseUrl: string | undefined = process.env.NEXT_PUBLIC_STATIC_ASSET_BASE_URL,
): { glueUrl: string; wasmUrl: string } {
  const resolveUrl = (logicalPath: keyof typeof BOARD_RENDERER_ASSET_OBJECT_KEYS): string =>
    baseUrl
      ? `${baseUrl.replace(/\/+$/, '')}/${BOARD_RENDERER_ASSET_OBJECT_KEYS[logicalPath]}`
      : `${origin}${logicalPath}`;

  return {
    glueUrl: resolveUrl('/wasm/board_renderer_wasm.js'),
    wasmUrl: resolveUrl('/wasm/board_renderer_wasm_bg.wasm'),
  };
}
