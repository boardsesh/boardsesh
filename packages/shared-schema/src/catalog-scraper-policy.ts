/** The announced migration window must elapse even if this ships beforehand. */
export const CATALOG_SCRAPER_BLOCK_START = '2026-12-02T12:00:00Z';
export const CATALOG_SCRAPER_BLOCK_START_MS = Date.parse(CATALOG_SCRAPER_BLOCK_START);
export const CATALOG_SCRAPER_USER_AGENT = 'moonboard-led-catalog/1.0';
export const CATALOG_SNAPSHOT_MANIFEST_URL = 'https://snapshots.boardsesh.com/board-snapshots/v1-gzip/manifest.json';

export const CATALOG_SCRAPER_REFUSAL = {
  code: 'CATALOG_SNAPSHOT_REQUIRED',
  message: 'Bulk catalog downloads must use the public board snapshots.',
  snapshotManifestUrl: CATALOG_SNAPSHOT_MANIFEST_URL,
  documentationUrl: 'https://github.com/boardsesh/boardsesh/blob/main/docs/data/board-snapshots-dataset.md',
} as const;

/**
 * Temporary containment for the published scraper, not client authentication.
 * Match the known complete UA only; ordinary browsers, native clients and
 * unrelated automation are governed by their usual access controls.
 */
export function isBlockedCatalogScraper(
  userAgent: string | null | undefined,
  pathname: string,
  now = Date.now(),
): boolean {
  if (now < CATALOG_SCRAPER_BLOCK_START_MS || userAgent?.toLowerCase() !== CATALOG_SCRAPER_USER_AGENT) {
    return false;
  }
  const normalizedPath = pathname.toLowerCase();
  return normalizedPath === '/graphql' || normalizedPath === '/api/v1' || normalizedPath.startsWith('/api/v1/');
}
