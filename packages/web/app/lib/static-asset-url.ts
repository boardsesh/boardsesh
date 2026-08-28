import { getStaticAssetObjectKey } from '@boardsesh/static-assets';

/**
 * Resolve a repository-owned runtime image.
 *
 * Production builds receive NEXT_PUBLIC_STATIC_ASSET_BASE_URL and use the
 * immutable Tigris object from the generated catalog. Local development and
 * branch previews deliberately leave the variable unset so newly-added images
 * remain reviewable from packages/web/public before main publishes them.
 */
export function resolveStaticAssetUrl(
  logicalPath: string,
  baseUrl: string | undefined = process.env.NEXT_PUBLIC_STATIC_ASSET_BASE_URL,
): string {
  const normalizedPath = logicalPath.startsWith('/') ? logicalPath : `/${logicalPath}`;
  if (!baseUrl) return normalizedPath;

  const objectKey = getStaticAssetObjectKey(normalizedPath);
  if (!objectKey) {
    throw new Error(`Static asset is missing from the generated catalog: ${normalizedPath}`);
  }

  return `${baseUrl.replace(/\/+$/, '')}/${objectKey}`;
}
