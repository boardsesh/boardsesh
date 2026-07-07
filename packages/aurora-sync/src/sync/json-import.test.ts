import { describe, expect, it } from 'vitest';
import { buildJsonImportAscentTickRow, generateJsonImportAuroraId, type AuroraExportAscent } from './json-import';

const NOW = '2026-07-03T00:00:00.000Z';
const CLIMB_UUID = 'climb-uuid-1';
const CLIMBED_AT = '2026-06-01T10:00:00.000Z';
const USER_ID = 'user-1';

function makeAscent(overrides: Partial<AuroraExportAscent> = {}): AuroraExportAscent {
  return {
    climb: 'Test Climb',
    angle: 40,
    count: 2,
    stars: 3,
    climbed_at: '2026-06-01 10:00:00',
    created_at: '2026-06-01 10:05:00',
    grade: '7a',
    ...overrides,
  };
}

describe('buildJsonImportAscentTickRow', () => {
  // Regression for #3390: the export 'stars' field is the raw Aurora 0-3
  // rating and must be converted to the Boardsesh 1-5 scale, not stored raw.
  it.each([
    { stars: 1, expected: 1 },
    { stars: 2, expected: 3 },
    { stars: 3, expected: 5 },
  ])('converts raw Aurora stars $stars to Boardsesh quality $expected', ({ stars, expected }) => {
    const row = buildJsonImportAscentTickRow(USER_ID, 'kilter', makeAscent({ stars }), CLIMB_UUID, CLIMBED_AT, NOW);
    expect(row.quality).toBe(expected);
  });

  it('stores unrated (stars 0) as null, not 0', () => {
    const row = buildJsonImportAscentTickRow(USER_ID, 'kilter', makeAscent({ stars: 0 }), CLIMB_UUID, CLIMBED_AT, NOW);
    expect(row.quality).toBeNull();
  });

  it('clamps out-of-range stars to the top of the scale', () => {
    const row = buildJsonImportAscentTickRow(USER_ID, 'kilter', makeAscent({ stars: 5 }), CLIMB_UUID, CLIMBED_AT, NOW);
    expect(row.quality).toBe(5);
  });

  it('builds the row with the deterministic json-import aurora id and matching sync timestamps', () => {
    const ascent = makeAscent();
    const row = buildJsonImportAscentTickRow(USER_ID, 'kilter', ascent, CLIMB_UUID, CLIMBED_AT, NOW);
    expect(row.auroraId).toBe(generateJsonImportAuroraId(USER_ID, CLIMB_UUID, ascent.angle, CLIMBED_AT, 'ascents'));
    expect(row.auroraType).toBe('ascents');
    // Imported from an Aurora export — already inside upstream, so origin
    // excludes it from the Boardsesh double-count guard.
    expect(row.origin).toBe('json_import');
    expect(row.status).toBe('send');
    expect(row.attemptCount).toBe(ascent.count);
    // The backfill migration's idempotency guard relies on freshly imported
    // rows having updated_at <= aurora_synced_at; both come from the same
    // timestamp here.
    expect(row.updatedAt).toBe(NOW);
    expect(row.auroraSyncedAt).toBe(NOW);
  });
});
