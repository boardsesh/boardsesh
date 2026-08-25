import { STATIC_ASSET_MANIFEST } from '@boardsesh/static-assets';

export type BoardBackgroundAsset = {
  objectKey: string;
};

/**
 * Tiny metadata-only lookup for board art. The binary WebPs are deliberately
 * absent: native wrappers package them through with-board-art-resources, while
 * the Expo browser target derives a CDN or same-origin URL from this catalog.
 */
export const BOARD_BACKGROUND_ASSETS: Readonly<Record<string, BoardBackgroundAsset>> = Object.freeze(
  Object.fromEntries(
    Object.values(STATIC_ASSET_MANIFEST)
      .filter((asset) => asset.nativeBundle && asset.logicalPath.startsWith('/images/'))
      .map((asset) => [asset.logicalPath.slice('/images/'.length), { objectKey: asset.objectKey }]),
  ),
);
