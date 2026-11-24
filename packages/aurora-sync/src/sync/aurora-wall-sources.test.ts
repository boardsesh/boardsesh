import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  boardUuidForSource,
  resolveDefaultAuroraLocationConfig,
  type PublicBoardLocationInput,
} from '@boardsesh/location-sync';
import { AURORA_LOCATION_BOARDS, buildAuroraLocationRecords, type AuroraPinWithUser } from './locations-sync';
import {
  buildAuroraSerialWitnesses,
  buildAuroraWallSourceMappings,
  syncAuroraWallSources,
} from './aurora-wall-sources';
import type { Wall } from '../api/sync-api-types';

function wall(uuid: string, overrides: Partial<Wall> = {}): Wall {
  return {
    uuid,
    name: uuid,
    user_id: 123,
    product_id: 5,
    is_adjustable: true,
    angle: 40,
    layout_id: 10,
    product_size_id: 6,
    hsm: 0,
    serial_number: '84771',
    set_ids: [12, 13],
    is_listed: true,
    created_at: `2026-01-${uuid === 'first' ? '01' : '02'} 00:00:00`,
    updated_at: '2026-01-01 00:00:00',
    ...overrides,
  };
}
function gym(walls: Wall[], id = 123): AuroraPinWithUser {
  return {
    pin: { id, username: 'gym', name: 'Gym', latitude: 40, longitude: 10 },
    user: { id, walls },
  };
}
function records(pins: AuroraPinWithUser[]): PublicBoardLocationInput[] {
  return buildAuroraLocationRecords('tension', pins).records;
}

describe('Aurora wall source identity', () => {
  it.each(AURORA_LOCATION_BOARDS)('keeps %s provenance in its own board namespace', (board) => {
    const config = resolveDefaultAuroraLocationConfig(board);
    expect(config).not.toBeNull();
    if (!config) throw new Error('Missing supported board config');
    const pins = [
      gym([
        wall('first', {
          layout_id: config.layoutId,
          product_size_id: config.sizeId,
          set_ids: config.setIds.split(',').map(Number),
        }),
      ]),
    ];
    const published = buildAuroraLocationRecords(board, pins).records;
    expect(buildAuroraWallSourceMappings(board, pins, published)).toMatchObject([
      { boardType: board, sourceKey: `${board}:123`, sourceBoardUuid: boardUuidForSource(`${board}:123`) },
    ]);
  });

  it('keeps the gym-level first-wall key and per-wall sibling key', () => {
    const pins = [gym([wall('second'), wall('first')])];
    const mappings = buildAuroraWallSourceMappings('tension', pins, records(pins));
    expect(mappings).toMatchObject([
      {
        sourceKey: 'tension:123',
        sourceBoardUuid: boardUuidForSource('tension:123'),
        wallUuid: 'first',
        serialNumber: '84771',
      },
      { sourceKey: 'tension:123:second', wallUuid: 'second' },
    ]);
  });

  it('does not give an unlisted first wall identity to a sibling', () => {
    const pins = [gym([wall('first', { is_listed: false }), wall('second')])];
    expect(buildAuroraWallSourceMappings('tension', pins, records(pins))).toMatchObject([
      { sourceKey: 'tension:123:second', wallUuid: 'second' },
    ]);
  });

  it('requires affirmative listing evidence without removing the public map row', () => {
    const unverifiedWall = wall('first');
    Reflect.deleteProperty(unverifiedWall, 'is_listed');
    const pins = [gym([unverifiedWall])];
    expect(records(pins)).toHaveLength(1);
    expect(buildAuroraWallSourceMappings('tension', pins, records(pins))).toEqual([]);
    expect(buildAuroraSerialWitnesses('tension', pins)).toMatchObject([
      { wallUuid: 'first', serialNumber: '84771', isListed: false },
    ]);
  });

  it('never mints exact provenance from a fallback or another gym response', () => {
    const pins = [gym([wall('first', { layout_id: 424242 })])];
    expect(buildAuroraWallSourceMappings('tension', pins, records(pins))).toEqual([]);
    const unknownSets = [gym([wall('first', { set_ids: [424242] })])];
    expect(buildAuroraWallSourceMappings('tension', unknownSets, records(unknownSets))).toEqual([]);
    const correctPins = [gym([wall('first')])];
    expect(
      buildAuroraWallSourceMappings(
        'tension',
        [{ ...correctPins[0], user: { id: 999, walls: [wall('first')] } }],
        records(correctPins),
      ),
    ).toEqual([]);
  });

  it.each([undefined, '', '   '])('does not publish a binding without a controller serial: %s', (serial) => {
    const pins = [gym([wall('first', { serial_number: serial })])];
    expect(buildAuroraWallSourceMappings('tension', pins, records(pins))).toEqual([]);
  });
});

function harness(existingBoardUuids: string[]) {
  const inserted: unknown[] = [];
  const predicates: SQL[] = [];
  let transactions = 0;
  const writer = {
    select: () => ({ from: () => ({ where: () => Promise.resolve(existingBoardUuids.map((uuid) => ({ uuid }))) }) }),
    update: () => ({
      set: () => ({
        where: (predicate: SQL) => {
          predicates.push(predicate);
          return Promise.resolve();
        },
      }),
    }),
    insert: () => ({
      values: (rows: unknown[]) => {
        inserted.push(...rows);
        return { onConflictDoUpdate: () => Promise.resolve() };
      },
    }),
  };
  const db = {
    transaction: async (operation: (transaction: typeof writer) => Promise<void>) => {
      transactions++;
      await operation(writer);
    },
  } as unknown as Parameters<typeof syncAuroraWallSources>[0];
  return { db, inserted, predicates, transactionCount: () => transactions };
}

describe('Aurora source refresh', () => {
  it('writes source rows only after their board exists and scopes unlisting to fetched gyms', async () => {
    const fetched = gym([wall('first')]);
    const unavailable: AuroraPinWithUser = { pin: { ...fetched.pin, id: 999 } };
    const pins = [fetched, unavailable];
    const state = harness([boardUuidForSource('tension:123')]);
    await syncAuroraWallSources(state.db, 'tension', pins, records(pins));
    expect(state.inserted).toHaveLength(2);
    expect(state.inserted[0]).toMatchObject({ gymUserId: 123, isListed: true });
    expect(state.inserted[1]).toMatchObject({ gymUserId: 123, isListed: false, sourceBoardUuid: null });
    const predicate = new PgDialect().sqlToQuery(state.predicates[0]);
    expect(predicate.sql).toContain('"board_type"');
    expect(predicate.sql).toContain('"gym_user_id"');
    expect(predicate.params).toContain('tension');
    expect(predicate.params).toContain(123);
    expect(predicate.params).not.toContain(999);
    expect(state.transactionCount()).toBe(1);
  });

  it('unlists a fetched empty gym without deleting its prior source identity', async () => {
    const pins = [gym([])];
    const state = harness([]);
    await syncAuroraWallSources(state.db, 'tension', pins, []);
    expect(state.inserted).toEqual([]);
    expect(state.predicates).toHaveLength(1);
    expect(new PgDialect().sqlToQuery(state.predicates[0]).params).toContain(123);
  });

  it('revokes live mappings when a fetched wall no longer includes a listing flag', async () => {
    const unverifiedWall = wall('first');
    Reflect.deleteProperty(unverifiedWall, 'is_listed');
    const pins = [gym([unverifiedWall])];
    const state = harness([boardUuidForSource('tension:123')]);
    await syncAuroraWallSources(state.db, 'tension', pins, records(pins));
    expect(state.predicates).toHaveLength(1);
    expect(new PgDialect().sqlToQuery(state.predicates[0]).params).toContain(123);
    expect(state.inserted).toMatchObject([{ sourceBoardUuid: null, isListed: false }]);
  });

  it('revokes only vanished gyms while retaining their serial witnesses', async () => {
    const state = harness([]);
    await syncAuroraWallSources(state.db, 'tension', [], [], [123]);
    expect(state.inserted).toEqual([]);
    expect(state.predicates).toHaveLength(1);
    const predicate = new PgDialect().sqlToQuery(state.predicates[0]);
    expect(predicate.sql).toContain('"board_type"');
    expect(predicate.sql).toContain('"is_listed"');
    expect(predicate.params).toEqual(['tension', 123, true]);
  });

  it('does not write or unlist anything for unavailable profiles or omitted wall snapshots', async () => {
    const state = harness([]);
    await syncAuroraWallSources(
      state.db,
      'tension',
      [{ pin: gym([]).pin }, { pin: gym([]).pin, user: { id: 123 } }],
      [],
    );
    expect(state.transactionCount()).toBe(0);
  });

  it('does not create foreign keys for a skipped public board', async () => {
    const pins = [gym([wall('first')])];
    const state = harness([]);
    await syncAuroraWallSources(state.db, 'tension', pins, records(pins));
    expect(state.inserted).toMatchObject([{ isListed: false, sourceBoardUuid: null, serialNumber: '84771' }]);
  });
});

describe('raw Aurora serial witnesses', () => {
  it('retains a fresh unlisted or unsupported wall sharing a listed wall serial', () => {
    const pins = [
      gym([wall('first'), wall('unlisted', { is_listed: false }), wall('unsupported', { layout_id: 424242 })]),
    ];
    const eligible = buildAuroraWallSourceMappings('tension', pins, records(pins));
    expect(eligible).toHaveLength(1);
    const witnesses = buildAuroraSerialWitnesses('tension', pins);
    expect(witnesses.map((entry) => entry.wallUuid)).toEqual(['first', 'unlisted', 'unsupported']);
    expect(
      witnesses.every((entry) => entry.serialNumber === '84771' && !entry.isListed && entry.sourceBoardUuid === null),
    ).toBe(true);
  });

  it('does not erase old serial observations when a controller is replaced', () => {
    const oldWitness = buildAuroraSerialWitnesses('tension', [gym([wall('first')])])[0];
    const newWitness = buildAuroraSerialWitnesses('tension', [
      gym([wall('first', { serial_number: 'new-serial' })]),
    ])[0];
    expect(oldWitness.sourceKey).not.toBe(newWitness.sourceKey);
  });

  it('persists a different gym slice without deactivating or overwriting earlier witnesses', async () => {
    const state = harness([]);
    const firstSlice = [gym([wall('first', { is_listed: false })], 123)];
    const secondSlice = [gym([wall('second', { layout_id: 424242 })], 456)];
    await syncAuroraWallSources(state.db, 'tension', firstSlice, records(firstSlice));
    await syncAuroraWallSources(state.db, 'tension', secondSlice, records(secondSlice));
    expect(state.inserted).toMatchObject([
      { gymUserId: 123, wallUuid: 'first', isListed: false, serialNumber: '84771' },
      { gymUserId: 456, wallUuid: 'second', isListed: false, serialNumber: '84771' },
    ]);
    expect(new PgDialect().sqlToQuery(state.predicates[1]).params).not.toContain(123);
  });

  it('rejects malformed raw identity/configuration instead of inventing a published board', () => {
    const pins = [gym([wall('first', { layout_id: Number.NaN }), wall('second', { product_size_id: -1 })])];
    expect(buildAuroraSerialWitnesses('tension', pins)).toEqual([]);
  });
});
