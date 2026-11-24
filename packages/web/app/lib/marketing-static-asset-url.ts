import { STATIC_MARKETING_ASSET_OBJECT_KEYS } from '@boardsesh/static-assets/marketing';

/** Resolve marketing captures and hero media without the complete board-image map. */
export function resolveMarketingStaticAssetUrl(
  logicalPath: string,
  baseUrl: string | undefined = process.env.NEXT_PUBLIC_STATIC_ASSET_BASE_URL,
): string {
  const normalizedPath = logicalPath.startsWith('/') ? logicalPath : `/${logicalPath}`;
  if (!baseUrl) return normalizedPath;
  const marketingCatalog: Readonly<Record<string, string>> = STATIC_MARKETING_ASSET_OBJECT_KEYS;
  const objectKey = marketingCatalog[normalizedPath];
  if (!objectKey) {
    throw new Error(`Static marketing asset is missing from the generated catalog: ${normalizedPath}`);
  }
  return `${baseUrl.replace(/\/+$/, '')}/${objectKey}`;
}
