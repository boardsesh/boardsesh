/** Public catalogue geometry only. Custom spray walls never enter this cache. */
export const AURA_ASSET_ORIGIN = 'https://assets.boardsesh.com';
export const AURA_GEOMETRY_FORMAT_REVISION = 2;
export const AURA_ATLAS_FORMAT_REVISION = 2;
export const AURA_COMPRESSED_BUDGET_BYTES = 256 * 1024 * 1024;
export const AURA_GENERATED_BUDGET_BYTES = 256 * 1024 * 1024;
export const AURA_GENERATED_MAX_ENTRIES = 4;

export type AuraGeometryScope = Readonly<{ boardType: string; layoutId: number; sizeId: number }>;

export type AuraGeometryAsset = AuraGeometryScope &
  Readonly<{
    geometryId: string;
    formatRevision: number;
    atlasFormatRevision: number;
    outputWidth: number;
    outputHeight: number;
    sha256: string;
    bytes: number;
    maxReach: number;
    pulseReach: number;
    objectKey: string;
  }>;

export type AuraGeometryManifest = Readonly<{
  version: 1;
  assets: readonly AuraGeometryAsset[];
}>;

const CATALOGUE_FAMILIES = new Set([
  'kilter',
  'tension',
  'decoy',
  'touchstone',
  'grasshopper',
  'soill',
  'moonboard',
  'woods',
]);
const SHA256 = /^[a-f0-9]{64}$/;

export function isAuraCatalogueFamily(boardType: string): boolean {
  return CATALOGUE_FAMILIES.has(boardType);
}

export function auraGeometryScopeKey(scope: AuraGeometryScope): string {
  return `${scope.boardType}:${scope.layoutId}:${scope.sizeId}`;
}

function positiveInteger(candidate: unknown, maximum: number): candidate is number {
  return typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate > 0 && candidate <= maximum;
}

export function isAuraGeometryAsset(candidate: unknown): candidate is AuraGeometryAsset {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
  const asset = candidate as Record<string, unknown>;
  return (
    typeof asset.boardType === 'string' &&
    CATALOGUE_FAMILIES.has(asset.boardType) &&
    positiveInteger(asset.layoutId, 0x7fffffff) &&
    positiveInteger(asset.sizeId, 0x7fffffff) &&
    asset.formatRevision === AURA_GEOMETRY_FORMAT_REVISION &&
    asset.atlasFormatRevision === AURA_ATLAS_FORMAT_REVISION &&
    typeof asset.geometryId === 'string' &&
    SHA256.test(asset.geometryId) &&
    typeof asset.sha256 === 'string' &&
    SHA256.test(asset.sha256) &&
    positiveInteger(asset.bytes, AURA_COMPRESSED_BUDGET_BYTES) &&
    positiveInteger(asset.outputWidth, 1536) &&
    positiveInteger(asset.outputHeight, 2304) &&
    typeof asset.maxReach === 'number' &&
    Number.isFinite(asset.maxReach) &&
    asset.maxReach > 0 &&
    asset.maxReach <= 512 &&
    asset.pulseReach === 1.35 &&
    asset.objectKey === `static/v1/${asset.sha256}.aura`
  );
}

/** Reject the entire revision, including duplicate identities, rather than guess. */
export function readAuraGeometryManifest(candidate: unknown): AuraGeometryManifest | null {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const manifest = candidate as Record<string, unknown>;
  if (manifest.version !== 1 || !Array.isArray(manifest.assets) || manifest.assets.length > 256) return null;
  const identities = new Set<string>();
  const sharedObjects = new Map<string, string>();
  for (const asset of manifest.assets) {
    if (!isAuraGeometryAsset(asset)) return null;
    const identity = `${auraGeometryScopeKey(asset)}:${asset.outputWidth}:${asset.outputHeight}`;
    if (identities.has(identity)) return null;
    identities.add(identity);
    const bounds = JSON.stringify([
      asset.geometryId,
      asset.formatRevision,
      asset.atlasFormatRevision,
      asset.outputWidth,
      asset.outputHeight,
      asset.bytes,
      asset.maxReach,
      asset.pulseReach,
    ]);
    const previousBounds = sharedObjects.get(asset.sha256);
    if (previousBounds !== undefined && previousBounds !== bounds) return null;
    sharedObjects.set(asset.sha256, bounds);
  }
  return { version: 1, assets: manifest.assets };
}

/** Resolution must match. Native code also validates each requested hold and reach. */
export function findAuraGeometryAsset(
  manifest: AuraGeometryManifest,
  scope: AuraGeometryScope,
  outputWidth: number,
  outputHeight: number,
): AuraGeometryAsset | null {
  const scopeKey = auraGeometryScopeKey(scope);
  return (
    manifest.assets.find(
      (asset) =>
        auraGeometryScopeKey(asset) === scopeKey &&
        asset.outputWidth === outputWidth &&
        asset.outputHeight === outputHeight,
    ) ?? null
  );
}
