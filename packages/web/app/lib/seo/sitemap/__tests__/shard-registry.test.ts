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
vi.mock('../climb-store', () => ({
  fetchClimbShardSummary: async () => ({ itemCount: 0, lastModified: null }),
  buildClimbShardPage: async () => ({ items: [], totalItems: 0 }),
  fetchStoredClimbPageLastmods: async () => [],
}));

const { PAGED_SHARD_REGISTRY, SHARD_REGISTRY } = await import('../shard-registry');

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
    // `app/sitemaps/*/route.ts` is a route crawlers can reach that the index
    // never lists, and only the filesystem knows it is there.
    //
    // The walk is split because W-23's paged shard is a directory that does NOT
    // end in `.xml` (`sitemaps/climbs/[page]/route.ts`) — the exact hole the
    // `.xml`-only version of this test left open.
    const onDisk = readdirSync(join(APP_ROOT, 'sitemaps'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    const fixed = new Set(SHARD_REGISTRY.map((shard) => `${shard.id}.xml`));
    const paged = new Set(PAGED_SHARD_REGISTRY.map((shard) => shard.routeDirectory));

    expect(onDisk.length).toBeGreaterThan(0);
    for (const directory of onDisk) {
      if (directory.endsWith('.xml')) {
        expect(fixed.has(directory), `unregistered shard route ${directory}`).toBe(true);
      } else {
        expect(paged.has(directory), `unregistered paged shard route ${directory}`).toBe(true);
        expect(existsSync(join(APP_ROOT, 'sitemaps', directory, '[page]', 'route.ts'))).toBe(true);
      }
    }
    expect(onDisk).toHaveLength(fixed.size + paged.size);
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

  it('marks the paged climbs shard as expecting URLs on the shard route', () => {
    // Fail-closed at the SHARD, degrade at the INDEX: a climbs page that renders
    // zero URLs is a regressed query (the summary already said items were
    // there), but a failing climbs summary must not 503 the whole index.
    expect(Object.fromEntries(PAGED_SHARD_REGISTRY.map((shard) => [shard.id, shard.expectsUrls]))).toEqual({
      climbs: true,
    });
  });

  it('keeps paged and fixed shard ids in one namespace', () => {
    const fixed = SHARD_REGISTRY.map((shard) => String(shard.id));
    const paged = PAGED_SHARD_REGISTRY.map((shard) => String(shard.id));
    expect(new Set([...fixed, ...paged]).size).toBe(fixed.length + paged.length);
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
