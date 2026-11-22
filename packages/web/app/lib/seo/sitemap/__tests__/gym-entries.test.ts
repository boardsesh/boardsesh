import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { buildGymEntries } from '../gym-entries';
import { expandAllLocales } from '../entries';

const fetchGymSitemapRows = vi.hoisted(() => vi.fn());
vi.mock('../gym-query', () => ({ fetchGymSitemapRows }));

beforeEach(() => {
  vi.stubEnv('GYM_DIRECTORY_INDEXING_ENABLED', 'true');
  fetchGymSitemapRows.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe('gym sitemap publication', () => {
  it('makes no backend request before duplicate cleanup is verified', async () => {
    vi.stubEnv('GYM_DIRECTORY_INDEXING_ENABLED', undefined);
    expect(await buildGymEntries()).toEqual([]);
    expect(fetchGymSitemapRows).not.toHaveBeenCalled();
  });

  it('publishes four clean directories and canonical venues with real timestamps', async () => {
    fetchGymSitemapRows.mockResolvedValue([{ slug: 'canonical-gym', updatedAt: '2026-11-20T12:00:00.000Z' }]);
    const entries = await buildGymEntries();
    expect(entries.map((entry) => entry.path)).toEqual([
      '/gyms',
      '/gyms/kilter',
      '/gyms/moonboard',
      '/gyms/tension',
      '/gym/canonical-gym',
    ]);
    expect(entries.slice(0, 4).every((entry) => entry.lastModified === undefined)).toBe(true);
    expect(entries[4].lastModified).toEqual(new Date('2026-11-20T12:00:00.000Z'));
    expect(expandAllLocales(entries)).toHaveLength(30);
  });

  it('propagates backend failures instead of silently publishing only directories', async () => {
    fetchGymSitemapRows.mockRejectedValue(new Error('backend unavailable'));
    await expect(buildGymEntries()).rejects.toThrow('backend unavailable');
  });

  it('withdraws a venue on the next read after the backend excludes it', async () => {
    fetchGymSitemapRows
      .mockResolvedValueOnce([{ slug: 'now-unlisted', updatedAt: '2026-11-20' }])
      .mockResolvedValueOnce([]);
    expect((await buildGymEntries()).some((entry) => entry.path === '/gym/now-unlisted')).toBe(true);
    expect((await buildGymEntries()).some((entry) => entry.path === '/gym/now-unlisted')).toBe(false);
  });

  it.each([
    [{ slug: '', updatedAt: '2026-11-20' }],
    [{ slug: 'gym', updatedAt: 'invalid' }],
    [
      { slug: 'gym', updatedAt: '2026-11-20' },
      { slug: 'gym', updatedAt: '2026-11-20' },
    ],
  ])('rejects malformed or duplicate rows', async (...rows) => {
    fetchGymSitemapRows.mockResolvedValue(rows);
    await expect(buildGymEntries()).rejects.toThrow('Invalid or duplicate');
  });
});
