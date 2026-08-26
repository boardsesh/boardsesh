import staticAssetObjectKeys from './generated/catalog.json';
import type { StaticAssetObjectKeyCatalog } from './types';

export type { StaticAssetManifest, StaticAssetObjectKeyCatalog, StaticAssetRecord } from './types';

export const STATIC_ASSET_ORIGIN = 'https://assets.boardsesh.com';

export const STATIC_ASSET_OBJECT_KEYS: StaticAssetObjectKeyCatalog = staticAssetObjectKeys;

export function getStaticAssetObjectKey(logicalPath: string): string | undefined {
  return STATIC_ASSET_OBJECT_KEYS[logicalPath];
}
