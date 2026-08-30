import { describe, expect, it } from 'vitest';
import { buildLocationUpsertPlan } from '@boardsesh/location-sync';
import { buildAuroraLocationRecords, type AuroraPinWithUser } from './locations-sync';
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
    // Never coerce: publishing a plausible-looking guess is the failure this
    // whole change exists to stop.
    const { records, skipped } = buildAuroraLocationRecords('tension', [withWalls([makeWall({ layout_id: 4242 })])]);

    expect(records).toEqual([]);
    expect(skipped).toEqual([
      { sourceKey: 'tension:123', reason: 'unsupported tension wall config layout 4242 size 6' },
    ]);
  });

  it('rejects a wall listing hold sets that do not belong to its layout and size', () => {
    const { records, skipped } = buildAuroraLocationRecords('tension', [withWalls([makeWall({ set_ids: [999] })])]);

    expect(records).toEqual([]);
    expect(skipped).toHaveLength(1);
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
