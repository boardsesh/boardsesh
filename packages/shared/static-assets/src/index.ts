import { STATIC_ASSET_MANIFEST } from './generated/catalog';
import type { StaticAssetManifest, StaticAssetRecord } from './types';

export type { StaticAssetManifest, StaticAssetRecord } from './types';
export { STATIC_ASSET_MANIFEST } from './generated/catalog';

export const STATIC_ASSET_ORIGIN = 'https://assets.boardsesh.com';

const staticAssetManifest: StaticAssetManifest = STATIC_ASSET_MANIFEST;

export const STATIC_ASSET_RECORDS: readonly StaticAssetRecord[] = Object.freeze(Object.values(STATIC_ASSET_MANIFEST));

export function getStaticAsset(logicalPath: string): StaticAssetRecord | undefined {
  return staticAssetManifest[logicalPath];
}

export function requireStaticAsset(logicalPath: string): StaticAssetRecord {
  const asset = getStaticAsset(logicalPath);
  if (!asset) throw new Error(`Static asset is not cataloged: ${logicalPath}`);
  return asset;
}

export function getStaticAssetUrl(logicalPath: string): string | undefined {
  const asset = getStaticAsset(logicalPath);
  return asset ? `${STATIC_ASSET_ORIGIN}/${asset.objectKey}` : undefined;
}

export function requireStaticAssetUrl(logicalPath: string): string {
  const asset = requireStaticAsset(logicalPath);
  return `${STATIC_ASSET_ORIGIN}/${asset.objectKey}`;
}
