import { describe, expect, it } from 'vitest';
import {
  CATALOG_SCRAPER_BLOCK_START_MS,
  CATALOG_SCRAPER_USER_AGENT,
  isBlockedCatalogScraper,
} from '../catalog-scraper-policy';

describe('the announced catalog scraper cutoff', () => {
  it('uses the December 2 noon UTC deadline announced in Boardhang issue 215', () => {
    expect(CATALOG_SCRAPER_BLOCK_START_MS).toBe(Date.UTC(2026, 11, 2, 12));
  });

  it.each(['/graphql', '/api/v1', '/api/v1/moonboard/2/climbs', '/API/V1/grades'])(
    '%s preserves the full notice window',
    (pathname) => {
      expect(isBlockedCatalogScraper(CATALOG_SCRAPER_USER_AGENT, pathname, CATALOG_SCRAPER_BLOCK_START_MS - 1)).toBe(
        false,
      );
      expect(isBlockedCatalogScraper(CATALOG_SCRAPER_USER_AGENT, pathname, CATALOG_SCRAPER_BLOCK_START_MS)).toBe(true);
      expect(isBlockedCatalogScraper(CATALOG_SCRAPER_USER_AGENT, pathname, CATALOG_SCRAPER_BLOCK_START_MS + 1)).toBe(
        true,
      );
    },
  );

  it('matches the known user agent case-insensitively', () => {
    expect(isBlockedCatalogScraper('MoonBoard-LED-Catalog/1.0', '/graphql', CATALOG_SCRAPER_BLOCK_START_MS)).toBe(true);
  });

  it.each([
    undefined,
    null,
    '',
    'Mozilla/5.0',
    'Boardsesh/1.0',
    'moonboard-led-catalog/1.01',
    'another-moonboard-led-catalog/1.0',
  ])('leaves unrelated client %j alone', (userAgent) => {
    expect(isBlockedCatalogScraper(userAgent, '/graphql', CATALOG_SCRAPER_BLOCK_START_MS)).toBe(false);
  });

  it.each([
    '/board-snapshots/v1-gzip/manifest.json',
    '/board-snapshots/v1-catalog/manifest.json',
    '/static/v1/board.webp',
    '/health',
    '/auth/native/refresh',
    '/api/auth/oauth2/token',
    '/v1/logbook/changes',
    '/api/v10/climbs',
    '/graphql-other',
  ])('leaves non-catalog path %s alone', (pathname) => {
    expect(isBlockedCatalogScraper(CATALOG_SCRAPER_USER_AGENT, pathname, CATALOG_SCRAPER_BLOCK_START_MS)).toBe(false);
  });
});
