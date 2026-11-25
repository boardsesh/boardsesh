import type { IncomingMessage, ServerResponse } from 'node:http';
import { CATALOG_SCRAPER_REFUSAL, isBlockedCatalogScraper } from '@boardsesh/shared-schema/catalog-scraper-policy';

export const CATALOG_SCRAPER_REFUSAL_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
} as const;

export function rejectCatalogScraperRequest(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
  if (!isBlockedCatalogScraper(req.headers['user-agent'], pathname)) return false;
  res.writeHead(403, CATALOG_SCRAPER_REFUSAL_HEADERS);
  res.end(JSON.stringify(CATALOG_SCRAPER_REFUSAL));
  return true;
}
