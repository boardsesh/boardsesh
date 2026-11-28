import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestSqliteDb } from '../../testing/sqlite-test-db';
import { runMigrations } from '../../db/migrations';
import { ensureMutationQueueTable } from '../../mutation-queue/schema';
import {
  boardHidesWithdrawnClimbs,
  isWithdrawnClimbTombstone,
  WITHDRAWN_TOMBSTONE_BOARD_TYPES,
  withdrawnClimbTombstoneSql,
} from '../withdrawn-climb';

// The two device copies this predicate replaced, verbatim from 11ae71c064. They
// disagreed on one column: the app's copy also required `frames IS NULL`.

// packages/shared/offline-sync/src/sync/quantum-retirement.ts (pull writer, snapshot import)
function legacyEngineSql(prefix = ''): string {
  return `${prefix}board_type = 'quantum' AND ${prefix}is_listed = 0 AND ${prefix}is_hidden = 1
    AND ${prefix}is_boardsesh_authored = 0 AND ${prefix}user_id IS NULL AND ${prefix}controller_route_uuid IS NULL`;
}
function legacyEngineDocument(document: Record<string, unknown>): boolean {
  return (
    document.board_type === 'quantum' &&
    document.is_listed === false &&
    document.is_hidden === true &&
    document.is_boardsesh_authored === false &&
    document.user_id === null &&
    document.controller_route_uuid === null
  );
}

// packages/mobile/src/db/queries/quantum-climb-retirement.ts (climb detail, playlists, search, actions)
const LEGACY_APP_SQL = `
  c.board_type = 'quantum'
  AND c.is_listed = 0
  AND c.is_hidden = 1
  AND c.is_boardsesh_authored = 0
  AND c.user_id IS NULL
  AND c.controller_route_uuid IS NULL
  AND c.frames IS NULL
`;

type TombstoneColumns = {
  board_type: string;
  is_listed: boolean | null;
  is_hidden: boolean | null;
  is_boardsesh_authored: boolean | null;
  user_id: string | null;
  controller_route_uuid: string | null;
  frames: string | null;
};

/** What `syncClimbSelectList` sends for a withdrawn Quantum route. */
const TOMBSTONE: TombstoneColumns = {
  board_type: 'quantum',
  is_listed: false,
  is_hidden: true,
  is_boardsesh_authored: false,
  user_id: null,
  controller_route_uuid: null,
  frames: null,
};

// The one input the old copies disagreed on. No writer produces it: the server
// clears frames in the same redaction, a snapshot never ships an unlisted Quantum
// row, and every other device writer stamps an owner.
const TOMBSTONE_WITH_HOLDS = 'tombstone-with-holds';

const SHAPES: Array<{ uuid: string; name: string; columns: TombstoneColumns; tombstone: boolean }> = [
  { uuid: 'tombstone', name: 'the redacted row the server sends', columns: TOMBSTONE, tombstone: true },
  {
    uuid: TOMBSTONE_WITH_HOLDS,
    name: 'the tombstone shape with holds still on it',
    columns: { ...TOMBSTONE, frames: 'p1r12' },
    tombstone: false,
  },
  {
    uuid: 'published',
    name: 'a published supplier route',
    columns: { ...TOMBSTONE, is_listed: true, is_hidden: false, controller_route_uuid: 'route', frames: 'p1r12' },
    tombstone: false,
  },
  { uuid: 'listed', name: 'listed', columns: { ...TOMBSTONE, is_listed: true }, tombstone: false },
  { uuid: 'visible', name: 'not hidden', columns: { ...TOMBSTONE, is_hidden: false }, tombstone: false },
  {
    uuid: 'app-authored',
    name: 'authored in the app',
    columns: { ...TOMBSTONE, is_boardsesh_authored: true },
    tombstone: false,
  },
  {
    uuid: 'pre-v16',
    name: 'pulled before v16 recorded provenance',
    columns: { ...TOMBSTONE, is_boardsesh_authored: null },
    tombstone: false,
  },
  { uuid: 'owned', name: 'owned by a climber', columns: { ...TOMBSTONE, user_id: 'setter' }, tombstone: false },
  {
    uuid: 'supplier-id',
    name: 'still carrying its supplier id',
    columns: { ...TOMBSTONE, controller_route_uuid: 'route' },
    tombstone: false,
  },
  {
    uuid: 'moonboard',
    name: 'on MoonBoard, which keeps withdrawn climbs readable',
    columns: { ...TOMBSTONE, board_type: 'moonboard' },
    tombstone: false,
  },
  {
    uuid: 'kilter',
    name: 'on Kilter, which keeps deleted climbs readable',
    columns: { ...TOMBSTONE, board_type: 'kilter' },
    tombstone: false,
  },
];

const sqliteFlag = (flag: boolean | null) => (flag === null ? null : flag ? 1 : 0);

describe('withdrawal tombstone predicate', () => {
  let db: TestSqliteDb;

  beforeEach(async () => {
    db = createTestDatabase();
    await ensureMutationQueueTable(db);
    await runMigrations(db);
    for (const { uuid, columns } of SHAPES) {
      await db.runAsync(
        `INSERT INTO board_climbs
          (uuid, board_type, layout_id, is_listed, is_hidden, is_boardsesh_authored, user_id, controller_route_uuid, frames)
         VALUES (?, ?, 9101, ?, ?, ?, ?, ?, ?)`,
        [
          uuid,
          columns.board_type,
          sqliteFlag(columns.is_listed),
          sqliteFlag(columns.is_hidden),
          sqliteFlag(columns.is_boardsesh_authored),
          columns.user_id,
          columns.controller_route_uuid,
          columns.frames,
        ],
      );
    }
  });
  afterEach(() => db.close());

  /** Unqualified columns resolve to `c` too, so one query shape serves both prefixes. */
  const matching = async (where: string) =>
    new Set(
      (await db.getAllAsync<{ uuid: string }>(`SELECT uuid FROM board_climbs c WHERE ${where}`)).map((row) => row.uuid),
    );

  it.each(SHAPES)('answers $name', async ({ uuid, columns, tombstone }) => {
    expect((await matching(withdrawnClimbTombstoneSql())).has(uuid)).toBe(tombstone);
    expect((await matching(withdrawnClimbTombstoneSql('c.'))).has(uuid)).toBe(tombstone);
    expect(isWithdrawnClimbTombstone(columns)).toBe(tombstone);
  });

  it("keeps the app copy's answer on every shape", async () => {
    expect(await matching(withdrawnClimbTombstoneSql('c.'))).toEqual(await matching(LEGACY_APP_SQL));
  });

  it("keeps the sync engine copy's answer everywhere but the tombstone shape with holds", async () => {
    const engine = await matching(legacyEngineSql());
    expect(engine.has(TOMBSTONE_WITH_HOLDS)).toBe(true);
    engine.delete(TOMBSTONE_WITH_HOLDS);
    expect(await matching(withdrawnClimbTombstoneSql())).toEqual(engine);
    for (const { uuid, columns } of SHAPES) {
      expect(isWithdrawnClimbTombstone(columns)).toBe(legacyEngineDocument(columns) && uuid !== TOMBSTONE_WITH_HOLDS);
    }
  });

  it('gates on the board list exactly, as the old `=== quantum` checks did', () => {
    expect(WITHDRAWN_TOMBSTONE_BOARD_TYPES).toEqual(['quantum']);
    expect(boardHidesWithdrawnClimbs('quantum')).toBe(true);
    expect(boardHidesWithdrawnClimbs('QUANTUM')).toBe(false);
    expect(boardHidesWithdrawnClimbs('moonboard')).toBe(false);
    expect(boardHidesWithdrawnClimbs(undefined)).toBe(false);
  });
});
