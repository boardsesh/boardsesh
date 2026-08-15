import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vite-plus/test';
import { buildGymEntries } from '../gym-entries';
import { buildSetterEntries } from '../setter-entries';

vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/server-popular-configs', () => ({
  getAllBoardConfigsOrThrow: async () => [],
}));
vi.mock('../playlist-query', () => ({
  fetchPlaylistSitemapRows: async () => [],
}));

const { SHARD_REGISTRY } = await import('../shard-registry');

const APP_ROOT = join(import.meta.dirname, '..', '..', '..', '..');

describe('SHARD_REGISTRY', () => {
  it('has a route file on disk for every shard, and the index route exists', () => {
    expect(existsSync(join(APP_ROOT, 'sitemap.xml', 'route.ts'))).toBe(true);
    for (const shard of SHARD_REGISTRY) {
      expect(existsSync(join(APP_ROOT, 'sitemaps', `${shard.id}.xml`, 'route.ts'))).toBe(true);
      expect(shard.path).toBe(`/sitemaps/${shard.id}.xml`);
    }
  });

  it('has no route directory on disk that the registry does not know about', () => {
    // Reads the real directory instead of restating the ids: an orphaned
    // `app/sitemaps/climbs.xml/route.ts` — exactly what W-23 adds — is a route
    // crawlers can reach that the index never lists, and only the filesystem
    // knows it is there.
    const onDisk = readdirSync(join(APP_ROOT, 'sitemaps'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.endsWith('.xml'))
      .map((entry) => entry.name);
    const registered = new Set(SHARD_REGISTRY.map((shard) => `${shard.id}.xml`));

    expect(onDisk.length).toBeGreaterThan(0);
    for (const directory of onDisk) {
      expect(registered.has(directory)).toBe(true);
    }
    expect(onDisk).toHaveLength(registered.size);
  });

  it('uses unique ids', () => {
    expect(new Set(SHARD_REGISTRY.map((shard) => shard.id)).size).toBe(SHARD_REGISTRY.length);
  });

  it('marks the catalogue-derived shards as expecting URLs and the user-content ones as not', () => {
    // `expectsUrls` is what turns an unexpectedly empty shard into a 503 rather
    // than a `<urlset></urlset>` that tells Google the pages were deleted.
    expect(Object.fromEntries(SHARD_REGISTRY.map((shard) => [shard.id, shard.expectsUrls]))).toEqual({
      static: true,
      boards: true,
      // Zero public playlists holding a climb is a legitimate state, and zero
      // gyms/setters is the declared-empty design — none of these may 503.
      playlists: false,
      gyms: false,
      setters: false,
    });
  });
});

describe('declared-empty shards', () => {
  it('ships gyms and setters empty, on purpose', () => {
    // Guards the #4381 hand-off: the routes answer 200 with a valid empty
    // <urlset> and only need their builder filled.
    expect(buildGymEntries()).toEqual([]);
    expect(buildSetterEntries()).toEqual([]);
  });
});
