import type { BoardBackgroundAsset } from './board-backgrounds-manifest';

function configuredStaticAssetBaseUrl(): string | null {
  const configuredBaseUrl = process.env.EXPO_PUBLIC_STATIC_ASSET_BASE_URL?.trim().replace(/\/+$/, '');
  return configuredBaseUrl || null;
}

/** Production Expo web sets the CDN base; local and PR builds stay same-origin. */
export function resolveBoardBackgroundAsset(asset: BoardBackgroundAsset, manifestKey: string): string {
  const staticAssetBaseUrl = configuredStaticAssetBaseUrl();
  return staticAssetBaseUrl ? `${staticAssetBaseUrl}/${asset.objectKey}` : `/images/${manifestKey}`;
}
