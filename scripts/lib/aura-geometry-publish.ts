import { createHash } from 'node:crypto';
import {
  AURA_ASSET_ORIGIN,
  readAuraGeometryManifest,
  type AuraGeometryAsset,
  type AuraGeometryManifest,
} from '../../packages/mobile/src/lib/aura-assets/manifest';
import { validatePublicAsset } from '../upload-static-assets';

export type AuraGeometryPublicationIO = Readonly<{
  readArtifact(asset: AuraGeometryAsset): Promise<Uint8Array>;
  putImmutable(asset: AuraGeometryAsset, bytes: Uint8Array): Promise<void>;
  verifyStoredObject(asset: AuraGeometryAsset): Promise<void>;
  verifyPublicObject(asset: AuraGeometryAsset): Promise<void>;
  releaseManifest(manifest: AuraGeometryManifest): Promise<void>;
}>;

/** Verify the actual download path, including a populated edge cache. */
export async function verifyAuraGeometryPublic(
  asset: AuraGeometryAsset,
  beforeRequest: () => Promise<void>,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let cacheStatus: string | null = null;
    await validatePublicAsset(
      { ...asset, logicalPath: asset.objectKey, contentType: 'application/octet-stream', nativeBundle: false },
      beforeRequest,
      async (request, init) => {
        const response = await fetchImpl(request, { ...init, redirect: 'error' });
        cacheStatus = response.headers.get('cf-cache-status')?.toUpperCase() ?? null;
        return response;
      },
      AURA_ASSET_ORIGIN,
    );
    // Full byte validation consumes a MISS so the response can populate this edge.
    if (cacheStatus === 'HIT') return;
    if (cacheStatus !== 'MISS') {
      throw new Error(`Aura CDN cache is ${cacheStatus ?? 'missing'} for ${asset.objectKey}`);
    }
  }
  throw new Error(`Aura CDN cache did not reach HIT for ${asset.objectKey}`);
}

/** A manifest is releasable only after every immutable object is proven twice. */
export async function publishAuraGeometryManifest(candidate: unknown, io: AuraGeometryPublicationIO): Promise<void> {
  const manifest = readAuraGeometryManifest(candidate);
  if (!manifest || manifest.assets.length === 0) throw new Error('Invalid or empty Aura geometry manifest');
  const uniqueAssets = [...new Map(manifest.assets.map((asset) => [asset.sha256, asset])).values()];
  for (const asset of uniqueAssets) {
    const bytes = await io.readArtifact(asset);
    if (bytes.byteLength !== asset.bytes || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) {
      throw new Error(`Aura geometry changed before publication: ${asset.objectKey}`);
    }
    await io.putImmutable(asset, bytes);
    await io.verifyStoredObject(asset);
    await io.verifyPublicObject(asset);
  }
  await io.releaseManifest(manifest);
}

export function requireDeterministicAuraGeometry(first: Uint8Array, regenerated: Uint8Array): string {
  const firstHash = createHash('sha256').update(first).digest('hex');
  const secondHash = createHash('sha256').update(regenerated).digest('hex');
  if (first.byteLength !== regenerated.byteLength || firstHash !== secondHash) {
    throw new Error('Aura geometry regeneration is not deterministic');
  }
  return firstHash;
}
