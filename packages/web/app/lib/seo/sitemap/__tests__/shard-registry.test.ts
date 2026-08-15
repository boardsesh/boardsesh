import { existsSync } from 'node:fs';
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

  it('has no route file that the registry does not know about', () => {
    const registered = new Set(SHARD_REGISTRY.map((shard) => `${shard.id}.xml`));
    // Kept in step with the directory listing so an orphaned route is caught too.
    for (const id of ['static', 'boards', 'gyms', 'setters', 'playlists']) {
      expect(registered.has(`${id}.xml`)).toBe(true);
    }
    expect(registered.size).toBe(5);
  });

  it('uses unique ids', () => {
    expect(new Set(SHARD_REGISTRY.map((shard) => shard.id)).size).toBe(SHARD_REGISTRY.length);
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
