import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mapRawGymRow } from '../graphql/resolvers/social/gyms';

// #4588: the proximity branch of searchGyms maps raw `db.execute` rows, whose
// `timestamp without time zone` columns arrive as offset-less strings. They are
// UTC by convention and must not be read in the host's zone.
describe('mapRawGymRow timestamps', () => {
  const originalTz = process.env.TZ;

  beforeAll(() => {
    process.env.TZ = 'Australia/Brisbane';
  });

  afterAll(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  const baseRow = {
    id: 1,
    uuid: 'gym-uuid',
    name: 'Test Gym',
    owner_id: 'owner',
    is_public: true,
  };

  it('runs under a non-UTC zone', () => {
    expect(new Date('2026-07-03T00:00:00.000Z').getHours()).toBe(10);
  });

  it('reads offset-less timestamp strings as UTC', () => {
    const naive = '2026-02-03 10:30:00';
    const mapped = mapRawGymRow({
      ...baseRow,
      hours_updated_at: naive,
      created_at: naive,
      updated_at: naive,
      deleted_at: naive,
      sync_frozen_at: naive,
    });
    for (const field of ['hoursUpdatedAt', 'createdAt', 'updatedAt', 'deletedAt', 'syncFrozenAt'] as const) {
      expect(mapped[field]?.toISOString(), field).toBe('2026-02-03T10:30:00.000Z');
    }
  });

  it('reads fractional-second naive strings as UTC', () => {
    const naive = '2026-02-03 10:30:00.123456';
    const mapped = mapRawGymRow({ ...baseRow, hours_updated_at: naive, created_at: naive, updated_at: naive });
    expect(mapped.hoursUpdatedAt?.toISOString()).toBe('2026-02-03T10:30:00.123Z');
  });

  it('passes Date through and keeps null as null', () => {
    const instant = new Date('2026-02-03T10:30:00.000Z');
    const mapped = mapRawGymRow({
      ...baseRow,
      hours_updated_at: instant,
      created_at: instant,
      updated_at: instant,
      deleted_at: null,
      sync_frozen_at: null,
    });
    expect(mapped.hoursUpdatedAt?.toISOString()).toBe('2026-02-03T10:30:00.000Z');
    expect(mapped.deletedAt).toBeNull();
    expect(mapped.syncFrozenAt).toBeNull();
  });
});
