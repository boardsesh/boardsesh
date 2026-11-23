import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadSchedulerConfig } from '../config';
import { REFRESH_SETTER_SITEMAP_SUMMARY_MUTATION, refreshSitemapSetters } from '../jobs/refresh-sitemap-setters';

const summary = {
  refreshed: true,
  itemCount: 31_000,
  lastModified: '2026-11-23T10:00:00.000Z',
  computedAt: '2026-11-23T12:10:30.000Z',
  skipped: null,
};

function jobContext() {
  return {
    config: loadSchedulerConfig({
      CRON_SECRET: 'test-secret',
      BOARDSESH_BACKEND_GRAPHQL_URL: 'https://backend.test/graphql',
    }),
    timeoutMs: 120_000,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload));
}

afterEach(() => vi.restoreAllMocks());

describe('refresh-sitemap-setters job', () => {
  it('posts a forced refresh with cron credentials and returns the persisted summary', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ data: { refreshSetterSitemapSummary: summary } }));
    await expect(refreshSitemapSetters(jobContext())).resolves.toEqual(summary);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://backend.test/graphql',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test-secret' }),
        body: JSON.stringify({ query: REFRESH_SETTER_SITEMAP_SUMMARY_MUTATION }),
      }),
    );
    expect(REFRESH_SETTER_SITEMAP_SUMMARY_MUTATION).toContain('force: true');
  });

  it.each([
    { ...summary, refreshed: false, skipped: 'fresh' },
    { ...summary, refreshed: false, skipped: 'locked' },
    { refreshed: false, itemCount: null, lastModified: null, computedAt: null, skipped: 'locked' },
  ])('accepts a benign skipped run', async (result) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ data: { refreshSetterSitemapSummary: result } }));
    await expect(refreshSitemapSetters(jobContext())).resolves.toEqual(result);
  });

  it('fails when GraphQL reports errors inside HTTP 200', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ errors: [{ message: 'scan failed' }], data: null }));
    await expect(refreshSitemapSetters(jobContext())).rejects.toThrow('GraphQL errors');
  });

  it.each([
    { ...summary, itemCount: 0 },
    { ...summary, computedAt: 'invalid' },
    { ...summary, lastModified: 'invalid' },
    { ...summary, refreshed: true, skipped: 'locked' },
    { ...summary, refreshed: false, skipped: null },
    { refreshed: false, itemCount: null, lastModified: null, computedAt: null, skipped: 'fresh' },
  ])('rejects a missing, invalid, or contradictory summary', async (result) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ data: { refreshSetterSitemapSummary: result } }));
    await expect(refreshSitemapSetters(jobContext())).rejects.toThrow('invalid result');
  });
});
