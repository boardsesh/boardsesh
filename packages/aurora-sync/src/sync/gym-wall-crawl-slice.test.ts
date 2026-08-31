import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuroraGymUser } from '../api/gym-walls-api';
import type { Wall } from '../api/sync-api-types';

const mocks = vi.hoisted(() => ({
  fetchAuroraPins: vi.fn(),
  upsertPublicBoardLocations: vi.fn(),
  markGymWallsCrawled: vi.fn(),
}));

vi.mock('../api/pins-api', () => ({ fetchAuroraPins: mocks.fetchAuroraPins }));
vi.mock('@boardsesh/location-sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@boardsesh/location-sync')>()),
  upsertPublicBoardLocations: mocks.upsertPublicBoardLocations,
}));
vi.mock('@boardsesh/db/queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@boardsesh/db/queries')>()),
  markGymWallsCrawled: mocks.markGymWallsCrawled,
  findCrawledGymSourceKeys: () => Promise.resolve(new Set<string>()),
}));

import { crawlGymWallsForSourceKeys } from './locations-sync';

function pin(id: number) {
  return { id, username: `gym-${id}`, name: `Gym ${id}`, latitude: -33.8, longitude: 151.2 };
}

function wall(overrides: Partial<Wall> = {}): Wall {
  return {
    uuid: 'wall-1',
    name: 'Main Wall',
    user_id: 1,
    product_id: 5,
    is_adjustable: true,
    angle: 40,
    layout_id: 11,
    product_size_id: 6,
    hsm: 0,
    serial_number: '841070',
    set_ids: [12, 13],
    is_listed: true,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const gymUser = (walls: Wall[]): AuroraGymUser => ({ id: 1, walls, gym: null });

beforeEach(() => {
  mocks.fetchAuroraPins.mockReset().mockResolvedValue({ gyms: [pin(269111), pin(253398), pin(269112)] });
  mocks.upsertPublicBoardLocations.mockReset().mockResolvedValue({
    boardsSeen: 0,
    boardsUpserted: 0,
    boardsSkipped: 0,
    gymsSeen: 0,
    gymsUpserted: 0,
    skipped: [],
  });
  mocks.markGymWallsCrawled.mockReset().mockResolvedValue(undefined);
});

/**
 * The daemon's incremental crawl. Aurora only exposes a gym's walls behind an
 * authenticated per-gym call, so without this every gym board is published from
 * a per-board guess — the Benchmark Climbing bug, where every Tension gym in
 * the world was stored as layout 10 ("Mirror").
 */
describe('crawlGymWallsForSourceKeys', () => {
  it('publishes the real wall config for the slice it was given', async () => {
    const read = await crawlGymWallsForSourceKeys({
      db: {} as never,
      board: 'tension',
      sourceKeys: ['tension:269111'],
      fetchGymUser: () => Promise.resolve(gymUser([wall()])),
    });

    expect(read).toBe(1);
    const [, records] = mocks.upsertPublicBoardLocations.mock.calls[0];
    expect(records[0]).toMatchObject({
      sourceKey: 'tension:269111',
      layoutId: 11,
      sizeId: 6,
      setIds: '12,13',
      serialNumber: '841070',
    });
  });

  it('only reads the gyms in the slice, not the whole pin list', async () => {
    // The slice is the entire point: a full crawl is hours at ~30 req/min and
    // this shares the shared-sync slot.
    const asked: number[] = [];
    await crawlGymWallsForSourceKeys({
      db: {} as never,
      board: 'tension',
      sourceKeys: ['tension:253398'],
      fetchGymUser: (p) => {
        asked.push(p.id);
        return Promise.resolve(gymUser([wall()]));
      },
    });

    expect(asked).toEqual([253398]);
  });

  it('does not stamp a gym whose read failed, so it is retried next cycle', async () => {
    await crawlGymWallsForSourceKeys({
      db: {} as never,
      board: 'tension',
      sourceKeys: ['tension:269111', 'tension:253398'],
      fetchGymUser: (p) => Promise.resolve(p.id === 269111 ? undefined : gymUser([wall()])),
    });

    expect(mocks.markGymWallsCrawled).toHaveBeenCalledWith({}, ['tension:253398']);
  });

  it('stamps a gym that genuinely has no walls', async () => {
    // A successful read that finds nothing is still a read. Left unstamped it
    // would be retried every cycle and starve the rest of the fleet.
    const read = await crawlGymWallsForSourceKeys({
      db: {} as never,
      board: 'tension',
      sourceKeys: ['tension:269111'],
      fetchGymUser: () => Promise.resolve(gymUser([])),
    });

    expect(read).toBe(1);
    expect(mocks.markGymWallsCrawled).toHaveBeenCalledWith({}, ['tension:269111']);
  });

  it('stamps a gym that has vanished from the pin list', async () => {
    // Closed, unlisted, or renumbered upstream. Retrying forever would block the
    // queue behind a gym that can never resolve.
    const read = await crawlGymWallsForSourceKeys({
      db: {} as never,
      board: 'tension',
      sourceKeys: ['tension:999999'],
      fetchGymUser: () => Promise.reject(new Error('should not be called')),
    });

    expect(read).toBe(1);
    expect(mocks.upsertPublicBoardLocations).not.toHaveBeenCalled();
  });

  it('writes nothing when every gym in the slice failed', async () => {
    await crawlGymWallsForSourceKeys({
      db: {} as never,
      board: 'tension',
      sourceKeys: ['tension:269111'],
      fetchGymUser: () => Promise.resolve(undefined),
    });

    expect(mocks.upsertPublicBoardLocations).not.toHaveBeenCalled();
    expect(mocks.markGymWallsCrawled).toHaveBeenCalledWith({}, []);
  });

  it('does no work at all for an empty slice', async () => {
    expect(
      await crawlGymWallsForSourceKeys({
        db: {} as never,
        board: 'tension',
        sourceKeys: [],
        fetchGymUser: () => Promise.reject(new Error('should not be called')),
      }),
    ).toBe(0);
    expect(mocks.fetchAuroraPins).not.toHaveBeenCalled();
  });
});
