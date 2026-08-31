import { describe, expect, it } from 'vitest';
import { buildLocationUpsertPlan } from '@boardsesh/location-sync';
import { vi } from 'vitest';
import {
  buildAuroraLocationRecords,
  syncAllAuroraBoardLocations,
  AURORA_LOCATION_BOARDS,
  GYM_CRAWL_PROGRESS_INTERVAL,
  type AuroraPinWithUser,
} from './locations-sync';
import type { AuroraGymUser } from '../api/gym-walls-api';
import type { Wall } from '../api/sync-api-types';

const BOARD_HOUSE_PIN = {
  id: 123,
  username: 'board-house',
  name: 'Board House',
  latitude: -33.86,
  longitude: 151.2,
};

function makeWall(overrides: Partial<Wall> = {}): Wall {
  return {
    uuid: 'wall-1',
    name: 'Main Wall',
    user_id: 123,
    product_id: 5,
    is_adjustable: true,
    angle: 40,
    // Tension Board 2 Spray — the layout the old hardcoded default never produced.
    layout_id: 11,
    product_size_id: 6,
    hsm: 0,
    serial_number: '751737',
    set_ids: [12, 13],
    is_listed: true,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function withWalls(walls: Wall[], gym: AuroraGymUser['gym'] = null): AuroraPinWithUser {
  return { pin: BOARD_HOUSE_PIN, user: { id: 123, username: 'board-house', walls, gym } };
}

describe('buildAuroraLocationRecords', () => {
  it('publishes the wall configuration Aurora actually reports', () => {
    // The bug this replaces: every Tension gym was hardcoded to layout 10
    // ("Tension Board 2 Mirror"), so Benchmark Climbing's Spray wall (layout 11)
    // was published as a Mirror and no gym board carried a serial at all.
    const { records, skipped } = buildAuroraLocationRecords('tension', [withWalls([makeWall()])]);

    expect(skipped).toEqual([]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      sourceKey: 'tension:123',
      gymSourceKey: 'tension:123',
      boardType: 'tension',
      layoutId: 11,
      sizeId: 6,
      setIds: '12,13',
      serialNumber: '751737',
      name: 'Board House - Main Wall',
      slugBase: 'Board House-tension',
      angle: 40,
      isAngleAdjustable: true,
    });
  });

  it('keeps the first wall on the gym-level source key so existing boards survive', () => {
    // Source keys hash into deterministic board UUIDs. A new key on the first
    // wall would mint a fresh board row and orphan the live one — its ticks,
    // its wall history, and any QR code printed for it.
    const { records } = buildAuroraLocationRecords('tension', [
      withWalls([
        makeWall({ uuid: 'wall-a', name: 'Wall A', created_at: '2026-01-01T00:00:00.000Z' }),
        makeWall({ uuid: 'wall-b', name: 'Wall B', created_at: '2026-02-01T00:00:00.000Z', serial_number: '999' }),
      ]),
    ]);

    expect(records.map((record) => record.sourceKey)).toEqual(['tension:123', 'tension:123:wall-b']);
    expect(records.map((record) => record.name)).toEqual(['Board House - Wall A', 'Board House - Wall B']);
  });

  it('does not hand the gym key to a sibling when the first wall is unlisted', () => {
    // The reported hazard: indexed within the LISTED subset, un-listing wall A
    // slid wall B up to index 0, so the gym's long-lived board row — with its
    // ticks, history and any printed QR code — was silently rewritten to wall
    // B's config, and B's own row was orphaned.
    const walls = [
      makeWall({ uuid: 'a', name: 'Wall A', created_at: '2026-01-01T00:00:00.000Z' }),
      makeWall({ uuid: 'b', name: 'Wall B', created_at: '2026-02-01T00:00:00.000Z' }),
    ];

    const before = buildAuroraLocationRecords('tension', [withWalls(walls)]);
    expect(before.records.map((record) => record.sourceKey)).toEqual(['tension:123', 'tension:123:b']);

    // Gym converts wall A to storage.
    const after = buildAuroraLocationRecords('tension', [withWalls([{ ...walls[0], is_listed: false }, walls[1]])]);

    expect(after.records.map((record) => record.sourceKey)).toEqual(['tension:123:b']);
    expect(after.records[0].name).toBe('Board House - Wall B');
  });

  it('keeps a new wall off the gym key, since it always sorts last', () => {
    const original = makeWall({ uuid: 'a', name: 'Wall A', created_at: '2026-01-01T00:00:00.000Z' });
    const added = makeWall({ uuid: 'z', name: 'Wall Z', created_at: '2026-06-01T00:00:00.000Z' });

    const { records } = buildAuroraLocationRecords('tension', [withWalls([added, original])]);

    expect(records.map((record) => record.sourceKey)).toEqual(['tension:123', 'tension:123:z']);
    expect(records[0].name).toBe('Board House - Wall A');
  });

  it('orders walls deterministically so "first" is stable across runs', () => {
    // Aurora does not promise an order. If it flipped between runs, the gym's
    // original board row would swap identity with a sibling every crawl.
    const walls = [
      makeWall({ uuid: 'wall-b', name: 'Wall B', created_at: '2026-02-01T00:00:00.000Z' }),
      makeWall({ uuid: 'wall-a', name: 'Wall A', created_at: '2026-01-01T00:00:00.000Z' }),
    ];
    const forward = buildAuroraLocationRecords('tension', [withWalls(walls)]);
    const reversed = buildAuroraLocationRecords('tension', [withWalls([...walls].reverse())]);

    expect(forward.records.map((record) => record.sourceKey)).toEqual(reversed.records.map((r) => r.sourceKey));
    expect(forward.records[0].name).toBe('Board House - Wall A');
  });

  it('skips an unlisted wall', () => {
    const { records, skipped } = buildAuroraLocationRecords('tension', [withWalls([makeWall({ is_listed: false })])]);

    expect(records).toHaveLength(1);
    // Falls back to the default config: the gym is real, we just can't read a
    // wall for it, and dropping the pin would remove the gym from the map.
    expect(records[0].layoutId).toBe(10);
    expect(skipped).toEqual([{ sourceKey: 'tension:123', reason: 'gym has no listed walls' }]);
  });

  it('rejects a wall whose layout or size is not in the catalogue', () => {
    // Never coerce the unknown config: publishing a plausible-looking guess for
    // a wall we can't read is the failure this whole change exists to stop.
    const { records, skipped } = buildAuroraLocationRecords('tension', [withWalls([makeWall({ layout_id: 4242 })])]);

    expect(skipped).toContainEqual({
      sourceKey: 'tension:123',
      reason: 'unsupported tension wall config layout 4242 size 6',
    });
  });

  it('still lists a gym whose every wall failed validation', () => {
    // The walls exist, so the no-listed-walls fallback never runs — without an
    // explicit second check the gym produced no record at all and silently
    // vanished from the map, contradicting "a gym never drops off the map".
    const { records, skipped } = buildAuroraLocationRecords('tension', [
      withWalls([makeWall({ uuid: 'a', layout_id: 4242 }), makeWall({ uuid: 'b', product_size_id: 4242 })]),
    ]);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ sourceKey: 'tension:123', layoutId: 10, name: 'Board House - Tension Board' });
    expect(skipped).toContainEqual({
      sourceKey: 'tension:123',
      reason: 'no listed wall had a supported config',
    });
  });

  it('reports the failed wall and the gym fallback as separate reasons', () => {
    // The first wall shares the gym's source key, so a failure there reports
    // twice against `tension:123`. Kept deliberately: the two entries say
    // different things — which wall config was unsupported, and that the gym
    // fell back to the default — and collapsing them would lose the first.
    // What IS collapsed is the same (sourceKey, reason) pair repeating.
    const { skipped } = buildAuroraLocationRecords('tension', [withWalls([makeWall({ layout_id: 4242 })])]);

    expect(skipped.map((entry) => entry.reason)).toEqual([
      'unsupported tension wall config layout 4242 size 6',
      'no listed wall had a supported config',
    ]);
  });

  it('collapses an identical skip reason repeated for one gym', () => {
    // Two walls failing the same way used to report the same line twice.
    const { skipped } = buildAuroraLocationRecords('tension', [
      withWalls([
        makeWall({ uuid: 'a', layout_id: 4242, created_at: '2026-01-01T00:00:00.000Z' }),
        makeWall({ uuid: 'b', layout_id: 4242, created_at: '2026-02-01T00:00:00.000Z' }),
      ]),
    ]);

    const unsupported = skipped.filter((entry) => entry.reason.startsWith('unsupported tension wall config'));
    expect(unsupported).toHaveLength(2);
    // Distinct source keys (gym key for wall a, per-wall key for wall b), so
    // both survive — the dedupe only removes an exact repeat.
    expect(new Set(unsupported.map((entry) => entry.sourceKey)).size).toBe(2);
  });

  it('rejects a wall listing hold sets that do not belong to its layout and size', () => {
    const { records, skipped } = buildAuroraLocationRecords('tension', [withWalls([makeWall({ set_ids: [999] })])]);

    // Falls back rather than publishing the unreadable wall, and says why.
    expect(records).toHaveLength(1);
    expect(records[0].layoutId).toBe(10);
    expect(skipped.map((entry) => entry.reason)).toContain('no listed wall had a supported config');
  });

  it('keeps the valid walls when only some of a gym fails validation', () => {
    // A partial failure must not trigger the whole-gym fallback — that would
    // republish the guess alongside a wall we read correctly.
    const { records, skipped } = buildAuroraLocationRecords('tension', [
      withWalls([
        makeWall({ uuid: 'a', name: 'Good', created_at: '2026-01-01T00:00:00.000Z' }),
        makeWall({ uuid: 'b', name: 'Bad', created_at: '2026-02-01T00:00:00.000Z', layout_id: 4242 }),
      ]),
    ]);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ layoutId: 11, name: 'Board House - Good' });
    expect(skipped.map((entry) => entry.reason)).not.toContain('no listed wall had a supported config');
  });

  it('leaves an already-crawled gym alone instead of republishing the guess', () => {
    // The rule that makes continuous crawling work. The pins-only sync runs
    // hourly and cannot read walls, so without this it would overwrite every
    // enriched row back to the layout-10 guess an hour after the crawl fixed it.
    const { records, skipped } = buildAuroraLocationRecords(
      'tension',
      [{ pin: BOARD_HOUSE_PIN }],
      new Set(['tension:123']),
    );

    expect(records).toEqual([]);
    expect(skipped).toEqual([
      { sourceKey: 'tension:123', reason: 'gym walls unavailable (keeping previously crawled config)' },
    ]);
  });

  it('still publishes the default for a gym that has never been crawled', () => {
    // Un-crawled gyms must keep today's behaviour exactly — a guessed config
    // beats no gym on the map.
    const { records } = buildAuroraLocationRecords('tension', [{ pin: BOARD_HOUSE_PIN }], new Set(['tension:999']));

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ sourceKey: 'tension:123', layoutId: 10 });
  });

  it('falls back to the default config when the gym could not be read', () => {
    // No credentials for this board, a 404, or a failed request. Behaviour has
    // to match the pre-enrichment sync exactly.
    const { records, skipped } = buildAuroraLocationRecords('tension', [{ pin: BOARD_HOUSE_PIN }]);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      sourceKey: 'tension:123',
      layoutId: 10,
      sizeId: 6,
      setIds: '12,13',
      name: 'Board House - Tension Board',
    });
    expect(records[0].serialNumber).toBeUndefined();
    expect(skipped).toEqual([{ sourceKey: 'tension:123', reason: 'gym walls unavailable' }]);
  });

  it('takes the address from the gym profile and the coordinates from the pin', () => {
    const { records } = buildAuroraLocationRecords('tension', [
      withWalls([makeWall()], {
        user_id: 123,
        address1: '1 Climb Street',
        city: 'Sydney',
        country: 'Australia',
        // Deliberately different from the pin: the pin is what the map has
        // always plotted, so it stays authoritative.
        latitude: 0,
        longitude: 0,
      }),
    ]);

    expect(records[0]).toMatchObject({
      gymAddress: '1 Climb Street, Sydney, Australia',
      locationName: 'Sydney, Australia',
      latitude: -33.86,
      longitude: 151.2,
    });
  });

  it('treats a fixed wall reporting angle 0 as the default angle', () => {
    const { records } = buildAuroraLocationRecords('tension', [
      withWalls([makeWall({ angle: 0, is_adjustable: false })]),
    ]);

    expect(records[0]).toMatchObject({ angle: 40, isAngleAdjustable: false });
  });

  it('keeps the skipped COUNT honest when the entries are collapsed', () => {
    // The collapse is for readability — one line instead of thousands — but
    // boardsSkipped is the number callers actually parse, so it must still say
    // how many gyms were skipped, not how many lines were printed.
    const pins = Array.from({ length: 3 }, (_unused, index) => ({
      pin: { ...BOARD_HOUSE_PIN, id: 100 + index },
    }));
    const { skipped } = buildAuroraLocationRecords('tension', pins);

    // The builder still reports one entry per gym; collapsing happens in the
    // sync, which adds skipped.length rather than the collapsed length.
    expect(skipped).toHaveLength(3);
    expect(skipped.every((entry) => entry.reason === 'gym walls unavailable')).toBe(true);
  });

  it('passes pins without valid coordinates to the shared skip path', () => {
    const { records, skipped } = buildAuroraLocationRecords('tension', [
      {
        pin: {
          id: 456,
          username: 'missing-latitude',
          name: 'Missing Latitude',
          latitude: null,
          longitude: 151.2,
        },
      },
    ]);

    const plan = buildLocationUpsertPlan(records);

    expect(skipped).toEqual([{ sourceKey: 'tension:456', reason: 'gym walls unavailable' }]);
    expect(plan.validRecords).toEqual([]);
    expect(plan.skipped).toEqual([{ sourceKey: 'tension:456', reason: 'invalid coordinates' }]);
  });
});

/**
 * The `syncLocations('all')` path builds one fetcher per board and dispatches
 * through a closure keyed on the board name. A wrong key there would silently
 * enrich nothing for every board while still reporting success, so the wiring
 * is pinned here rather than left to a live crawl to discover.
 */
describe('syncAllAuroraBoardLocations fetcher dispatch', () => {
  it('asks for each gym under the board it belongs to', async () => {
    const requested: Array<{ board: string; pinId: number }> = [];
    const upserted = { boardsSeen: 0, boardsUpserted: 0, boardsSkipped: 0, gymsSeen: 0, gymsUpserted: 0, skipped: [] };

    vi.doMock('../api/pins-api', () => ({
      fetchAuroraPins: (board: string) => Promise.resolve({ gyms: [{ ...BOARD_HOUSE_PIN, id: board.length }] }),
    }));
    vi.doMock('@boardsesh/location-sync', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@boardsesh/location-sync')>()),
      upsertPublicBoardLocations: () => Promise.resolve(upserted),
    }));
    // The sync now asks which gyms already carry crawled wall data so it can
    // avoid republishing the guess over them; these tests stub the db entirely.
    vi.doMock('@boardsesh/db/queries', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@boardsesh/db/queries')>()),
      findCrawledGymSourceKeys: () => Promise.resolve(new Set<string>()),
      markGymWallsCrawled: () => Promise.resolve(),
    }));
    vi.resetModules();

    try {
      const { syncAllAuroraBoardLocations: syncAll } = await import('./locations-sync');

      await syncAll({
        db: {} as never,
        fetchGymUser: (board, pin) => {
          requested.push({ board, pinId: pin.id });
          return Promise.resolve(undefined);
        },
      });

      // One request per board, each carrying that board's own pin id.
      expect(requested).toEqual(AURORA_LOCATION_BOARDS.map((board) => ({ board, pinId: board.length })));
    } finally {
      // In a finally so a failed assertion can't leak these module mocks into
      // every test that runs after it.
      vi.doUnmock('../api/pins-api');
      vi.doUnmock('@boardsesh/location-sync');
      vi.doUnmock('@boardsesh/db/queries');
      vi.resetModules();
    }
  });

  it('stamps the gyms it read so the hourly sync stops overwriting them', async () => {
    // The gap this closes: only the daemon crawl used to stamp, so a gym
    // enriched by the explicit syncLocations command was republished as the
    // guess an hour later — the enrichment silently undone.
    const stamped: string[][] = [];
    const upserted = { boardsSeen: 0, boardsUpserted: 0, boardsSkipped: 0, gymsSeen: 0, gymsUpserted: 0, skipped: [] };

    vi.doMock('../api/pins-api', () => ({
      fetchAuroraPins: () => Promise.resolve({ gyms: [BOARD_HOUSE_PIN, { ...BOARD_HOUSE_PIN, id: 999 }] }),
    }));
    vi.doMock('@boardsesh/location-sync', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@boardsesh/location-sync')>()),
      upsertPublicBoardLocations: () => Promise.resolve(upserted),
    }));
    vi.doMock('@boardsesh/db/queries', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@boardsesh/db/queries')>()),
      findCrawledGymSourceKeys: () => Promise.resolve(new Set<string>()),
      markGymWallsCrawled: (_db: unknown, keys: string[]) => {
        stamped.push(keys);
        return Promise.resolve();
      },
    }));
    vi.resetModules();

    try {
      const { syncAuroraBoardLocations: syncBoard } = await import('./locations-sync');
      await syncBoard({
        db: {} as never,
        board: 'tension',
        // Gym 123 reads fine; 999 fails, so only the first may be stamped.
        fetchGymUser: (p) => Promise.resolve(p.id === 123 ? { id: 123, walls: [makeWall()], gym: null } : undefined),
      });

      expect(stamped).toEqual([['tension:123']]);
    } finally {
      vi.doUnmock('../api/pins-api');
      vi.doUnmock('@boardsesh/location-sync');
      vi.doUnmock('@boardsesh/db/queries');
      vi.resetModules();
    }
  });

  it('logs progress on the interval and always on the last gym', async () => {
    // The only production signal during a multi-hour crawl that a healthy run
    // isn't a stalled one — a run ending on "read 450/476" is indistinguishable
    // from a stall on the final stretch.
    const logs: string[] = [];
    const gymCount = GYM_CRAWL_PROGRESS_INTERVAL + 3;
    const upserted = { boardsSeen: 0, boardsUpserted: 0, boardsSkipped: 0, gymsSeen: 0, gymsUpserted: 0, skipped: [] };

    vi.doMock('../api/pins-api', () => ({
      fetchAuroraPins: () =>
        Promise.resolve({ gyms: Array.from({ length: gymCount }, (_u, i) => ({ ...BOARD_HOUSE_PIN, id: i + 1 })) }),
    }));
    vi.doMock('@boardsesh/location-sync', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@boardsesh/location-sync')>()),
      upsertPublicBoardLocations: () => Promise.resolve(upserted),
    }));
    // The sync now asks which gyms already carry crawled wall data so it can
    // avoid republishing the guess over them; these tests stub the db entirely.
    vi.doMock('@boardsesh/db/queries', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@boardsesh/db/queries')>()),
      findCrawledGymSourceKeys: () => Promise.resolve(new Set<string>()),
      markGymWallsCrawled: () => Promise.resolve(),
    }));
    vi.resetModules();

    try {
      const { syncAuroraBoardLocations: syncBoard } = await import('./locations-sync');
      await syncBoard({
        db: {} as never,
        board: 'tension',
        fetchGymUser: () => Promise.resolve(undefined),
        log: (message) => logs.push(message),
      });

      expect(logs).toContain(`[aurora-locations] tension: read ${GYM_CRAWL_PROGRESS_INTERVAL}/${gymCount} gym(s)`);
      expect(logs).toContain(`[aurora-locations] tension: read ${gymCount}/${gymCount} gym(s)`);
    } finally {
      vi.doUnmock('../api/pins-api');
      vi.doUnmock('@boardsesh/location-sync');
      vi.doUnmock('@boardsesh/db/queries');
      vi.resetModules();
    }
  });

  it('is exported for every Aurora board except Kilter', () => {
    // Kilter has its own richer per-wall importer in kilter-sync.
    expect(AURORA_LOCATION_BOARDS).not.toContain('kilter');
    expect(AURORA_LOCATION_BOARDS.length).toBeGreaterThan(0);
    expect(typeof syncAllAuroraBoardLocations).toBe('function');
  });
});
