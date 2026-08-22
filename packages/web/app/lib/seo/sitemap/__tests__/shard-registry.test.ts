import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vite-plus/test';
import type { PopularBoardConfig } from '@boardsesh/shared-schema';
import { buildGymEntries } from '../gym-entries';
import { buildSetterEntries } from '../setter-entries';

vi.mock('server-only', () => ({}));

const KILTER_CONFIG: PopularBoardConfig = {
  boardType: 'kilter',
  layoutId: 1,
  layoutName: 'Kilter Board Original',
  sizeId: 10,
  sizeName: '12 x 12 with kickboard',
  sizeDescription: '12 x 12 Square',
  setIds: [1, 20],
  setNames: ['Bolt Ons', 'Screw Ons'],
  climbCount: 4200,
  totalAscents: 99,
  boardCount: 7,
  displayName: 'Kilter OG 12x12',
};

/** The shape `board-config-source` synthesises: Masters 2017, every hold set. */
const MOONBOARD_CONFIG: PopularBoardConfig = {
  boardType: 'moonboard',
  layoutId: 4,
  layoutName: 'MoonBoard Masters 2017',
  sizeId: 1,
  sizeName: 'Standard',
  sizeDescription: '11x18 Grid',
  setIds: [11, 12, 13, 14, 15, 16],
  setNames: ['Hold Set A', 'Hold Set B', 'Hold Set C', 'Original School Holds', 'Screw-on Feet', 'Wooden Holds'],
  climbCount: 54678,
  totalAscents: 0,
  boardCount: 0,
  displayName: 'MoonBoard Masters 2017',
};
vi.mock('../board-config-source', () => ({
  getBoardsShardConfigsOrThrow: async () => [KILTER_CONFIG, MOONBOARD_CONFIG],
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

  it('builds MoonBoard URLs into the boards shard, not just into the climb shards', async () => {
    // The half-migration this catches: wiring only the climb shards to the
    // sitemap config source and leaving the boards shard on the listed-config
    // fetch. The climb shards would then emit tens of thousands of MoonBoard
    // URLs while `/sitemaps/boards.xml` carried none, and nothing else here
    // would go red.
    const boards = SHARD_REGISTRY.find((shard) => shard.id === 'boards');
    expect(boards).toBeDefined();

    const items = await boards!.build();
    const moonBoardPaths = items.map((item) => item.path).filter((path) => path.startsWith('/moonboard/'));

    // Both MoonBoard angles, and nothing else on the board.
    expect(moonBoardPaths).toHaveLength(2);
    for (const path of moonBoardPaths) {
      // `//` is the empty-path-segment shape `popularConfigListUrl` emits when
      // it falls into its name branch with no set names — a 404 handed to Google.
      expect(path).not.toContain('//');
      expect(path).not.toContain('?');
    }
    expect(items.some((item) => item.path.startsWith('/kilter/'))).toBe(true);
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
