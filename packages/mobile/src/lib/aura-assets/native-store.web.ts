import type { AuraGeometryAsset, AuraGeometryManifest, AuraGeometryScope } from './manifest';

export const auraGeometryManifest: AuraGeometryManifest = { version: 1, assets: [] };
export const auraGeometryCache = {
  chooseLocal(_asset: AuraGeometryAsset): string | null {
    return null;
  },
  async prefetch(_selected: AuraGeometryScope | null, _offline: readonly AuraGeometryScope[]): Promise<void> {},
  stop(): void {},
};
export function selectAuraGeometryPaths(_scope: AuraGeometryScope, _width: number, _height: number) {
  return { geometryAssetPath: null, geometryAssetSha256: null, generatedGeometryDirectory: null };
}
export function rememberAuraOfflineScopes(_scopes: readonly AuraGeometryScope[]): void {}
