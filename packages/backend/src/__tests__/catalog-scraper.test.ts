import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  CATALOG_SCRAPER_BLOCK_START_MS,
  CATALOG_SCRAPER_REFUSAL,
  CATALOG_SCRAPER_USER_AGENT,
} from '@boardsesh/shared-schema/catalog-scraper-policy';
import { rejectCatalogScraperRequest } from '../handlers/catalog-scraper';

describe('catalog scraper HTTP refusal', () => {
  afterEach(() => vi.restoreAllMocks());

  function response() {
    const writeHead = vi.fn();
    const end = vi.fn();
    return { writeHead, end, outgoing: { writeHead, end } as unknown as ServerResponse };
  }

  it('returns a no-store 403 with the supported migration path', () => {
    vi.spyOn(Date, 'now').mockReturnValue(CATALOG_SCRAPER_BLOCK_START_MS);
    const { outgoing, writeHead, end } = response();
    const incoming = { headers: { 'user-agent': CATALOG_SCRAPER_USER_AGENT } } as IncomingMessage;
    expect(rejectCatalogScraperRequest(incoming, outgoing, '/graphql')).toBe(true);
    expect(writeHead).toHaveBeenCalledWith(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    expect(end).toHaveBeenCalledWith(JSON.stringify(CATALOG_SCRAPER_REFUSAL));
  });

  it('does not write a response during the notice period', () => {
    vi.spyOn(Date, 'now').mockReturnValue(CATALOG_SCRAPER_BLOCK_START_MS - 1);
    const { outgoing, writeHead, end } = response();
    const incoming = { headers: { 'user-agent': CATALOG_SCRAPER_USER_AGENT } } as IncomingMessage;
    expect(rejectCatalogScraperRequest(incoming, outgoing, '/graphql')).toBe(false);
    expect(writeHead).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
  });
});
