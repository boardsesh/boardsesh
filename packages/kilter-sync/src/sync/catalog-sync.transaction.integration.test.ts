// Integration test for issue #3538: a per-Grips-layout catalog flush
// (climbs + holds + aliases + denormalized columns) must be atomic.
//
// Before the fix, `syncBoardLayoutGroup` ran these four steps as separate
// autocommit statement groups. A process kill (SIGKILL on deploy, OOM, crash)
// between the climbs insert and any later step left a `board_climbs` row
// committed (is_listed=true, hold_fingerprint set) with no
// `board_climb_holds` rows and NULL required_set_ids/compatible_size_ids —
// and the next cycle's UUID-identity short-circuit matches it by uuid and
// skips hold/fingerprint re-derivation forever (no self-heal).
//
// This test drives the real `flushKilterLayoutBatch` against a migrated
// Postgres (the dev DB) on an AUTOCOMMIT connection — deliberately NOT wrapped
// in an outer rollback transaction. That is load-bearing: the orphaned-row
// symptom only exists when the flush's statements commit independently, so a
// fixture transaction around the test would hide it (a mid-flush FK error
// would poison the fixture transaction instead of leaving a stranded climb).
// Every row it writes is tagged with a unique per-run uuid prefix and deleted
// in a `finally`.
//
// It self-skips when DATABASE_URL is not a local database, so it does NOT run
// in CI. Run it locally against the dev DB with:
//
//   DATABASE_URL=postgres://…@localhost:5432/… \
//     vp test run --reporter=agent packages/kilter-sync/src/sync/catalog-sync.transaction.integration.test.ts

import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, closePool, executeRows } from '@boardsesh/db/client';
import type { NewBoardClimb } from '@boardsesh/db/schema';
import { flushKilterLayoutBatch } from './catalog-sync';

function localDatabaseUrl(): string | null {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return null;
  }
  let hostname: string;
  try {
    hostname = new URL(databaseUrl).hostname.toLowerCase();
  } catch {
    // A malformed DATABASE_URL should skip the file, not crash it at import.
    return null;
  }
  return ['localhost', '127.0.0.1', 'postgres'].includes(hostname) ? databaseUrl : null;
}

const describeIntegration = localDatabaseUrl() ? describe : describe.skip;

// A real kilter layout, because `populateDenormalizedColumns` resolves the hold
// ids in `frames` through board_placements scoped to (board_type, layout_id).
// With a fake layout id the joins match nothing and the denormalized-columns
// step — half of the #3538 symptom — would be a silent no-op here.
const KILTER_LAYOUT_ID = 1;
const HOLD_IDS = [1073, 1074];
const FRAMES = HOLD_IDS.map((holdId) => `p${holdId}r12`).join('');

function fakeClimb(uuid: string, name: string): NewBoardClimb {
  return {
    uuid,
    boardType: 'kilter',
    layoutId: KILTER_LAYOUT_ID,
    setterId: null,
    setterUsername: 'issue-3538-tester',
    name,
    description: '',
    characteristics: null,
    // Left NULL on purpose: populateDenormalizedColumns derives the edges from
    // the frames hold ids, which is the precondition for required_set_ids.
    edgeLeft: null,
    edgeRight: null,
    edgeBottom: null,
    edgeTop: null,
    framesCount: 1,
    framesPace: 0,
    frames: FRAMES,
    isDraft: false,
    isListed: true,
    createdAt: new Date().toISOString(),
    holdFingerprint: `fp-${uuid}`,
  };
}

describeIntegration('Kilter catalog layout flush is atomic (issue #3538)', () => {
  it('lands climbs+holds+aliases+denormalized columns together, and leaves no orphan on a mid-flush failure', async (testContext) => {
    const db = createDb();

    try {
      const [schema] = await executeRows<{ climbsTable: string | null }>(
        db,
        sql`SELECT to_regclass('public.board_climbs')::text AS "climbsTable"`,
      );
      if (!schema?.climbsTable) {
        testContext.skip();
        return;
      }
    } catch {
      testContext.skip();
      return;
    }

    const [placements] = await executeRows<{ n: number | string }>(
      db,
      sql`SELECT count(*)::int AS n FROM board_placements
          WHERE board_type = 'kilter' AND layout_id = ${KILTER_LAYOUT_ID} AND id = ANY(${sql`ARRAY[${sql.join(
            HOLD_IDS.map((holdId) => sql`${holdId}`),
            sql`, `,
          )}]::int[]`})`,
    );
    if (Number(placements?.n ?? 0) !== HOLD_IDS.length) {
      // No board catalog seeded — the denormalized-columns assertions below
      // would be vacuous, so skip rather than assert nothing.
      testContext.skip();
      return;
    }

    const tag = `3538-${Date.now()}`;
    const happyUuid = `${tag}-happy`;
    const abortUuid = `${tag}-abort`;
    const missingHoldClimbUuid = `${tag}-never-inserted`;

    const climbCount = async (uuid: string): Promise<number> => {
      const [row] = await executeRows<{ n: number | string }>(
        db,
        sql`SELECT count(*)::int AS n FROM board_climbs WHERE uuid = ${uuid}`,
      );
      return Number(row?.n ?? 0);
    };
    const holdCount = async (uuid: string): Promise<number> => {
      const [row] = await executeRows<{ n: number | string }>(
        db,
        sql`SELECT count(*)::int AS n FROM board_climb_holds WHERE climb_uuid = ${uuid}`,
      );
      return Number(row?.n ?? 0);
    };
    const aliasCount = async (uuid: string): Promise<number> => {
      const [row] = await executeRows<{ n: number | string }>(
        db,
        sql`SELECT count(*)::int AS n FROM board_climb_aliases WHERE canonical_uuid = ${uuid}`,
      );
      return Number(row?.n ?? 0);
    };

    try {
      // --- Happy path: one new canonical, its holds, its self-alias, and the
      // denormalized columns the last in-transaction step fills in. ---
      await flushKilterLayoutBatch(
        db,
        [fakeClimb(happyUuid, 'Issue 3538 happy path')],
        HOLD_IDS.map((holdId) => ({
          boardType: 'kilter',
          climbUuid: happyUuid,
          holdId,
          frameNumber: 1,
          holdState: 'ON',
        })),
        [{ boardType: 'kilter', aliasUuid: happyUuid, canonicalUuid: happyUuid, source: 'kilter' }],
      );
      expect(await climbCount(happyUuid)).toBe(1);
      expect(await holdCount(happyUuid)).toBe(HOLD_IDS.length);
      expect(await aliasCount(happyUuid)).toBe(1);

      // The other half of the #3538 symptom: a stranded climb also has NULL
      // required_set_ids, so board filtering silently drops it. Assert the
      // denormalized step really ran inside the same flush.
      const [denorm] = await executeRows<{ requiredSetIds: number[] | null; edgeLeft: number | null }>(
        db,
        sql`SELECT required_set_ids AS "requiredSetIds", edge_left AS "edgeLeft"
            FROM board_climbs WHERE uuid = ${happyUuid}`,
      );
      expect(denorm?.requiredSetIds).not.toBeNull();
      expect(denorm?.requiredSetIds?.length).toBeGreaterThan(0);
      expect(denorm?.edgeLeft).not.toBeNull();

      // --- Atomicity path: the holds insert references a climb uuid that was
      // never inserted anywhere (not this batch, not previously), so
      // board_climb_holds_climb_fk rejects it with a real FK violation —
      // naturally simulating a mid-flush abort. ---
      let sawExpectedFailure = false;
      try {
        await flushKilterLayoutBatch(
          db,
          [fakeClimb(abortUuid, 'Issue 3538 abort path')],
          [
            {
              boardType: 'kilter',
              climbUuid: missingHoldClimbUuid,
              holdId: HOLD_IDS[0],
              frameNumber: 1,
              holdState: 'ON',
            },
          ],
          [{ boardType: 'kilter', aliasUuid: abortUuid, canonicalUuid: abortUuid, source: 'kilter' }],
        );
      } catch {
        sawExpectedFailure = true;
      }
      expect(sawExpectedFailure).toBe(true);

      // Load-bearing assertion, and the exact #3538 mechanism: on this
      // autocommit connection the climbs insert commits on its own unless the
      // flush wraps the batch in a transaction. Revert `flushKilterLayoutBatch`
      // to separate awaited statements and this reads 1 — a climb row with
      // is_listed=true, a hold_fingerprint, zero holds and NULL
      // required_set_ids, which no later cycle ever repairs.
      expect(await climbCount(abortUuid)).toBe(0);
      expect(await holdCount(abortUuid)).toBe(0);
      expect(await aliasCount(abortUuid)).toBe(0);

      // The earlier, already-committed happy-path batch is untouched by the
      // aborted one — the rollback is scoped to its own batch.
      expect(await climbCount(happyUuid)).toBe(1);
      expect(await holdCount(happyUuid)).toBe(HOLD_IDS.length);
    } finally {
      // Runs on assertion failure too, so a red test still leaves the dev DB
      // clean. Holds/aliases would cascade from board_climbs, but delete them
      // explicitly so a partially-committed pre-fix state is cleaned as well.
      const tagPrefix = `${tag}-%`;
      await db.execute(sql`DELETE FROM board_climb_holds WHERE climb_uuid LIKE ${tagPrefix}`);
      // Match both columns: this fixture only writes self-aliases, but an alias
      // pointing AT a tagged canonical from a tagged alias uuid must not leak.
      await db.execute(
        sql`DELETE FROM board_climb_aliases WHERE alias_uuid LIKE ${tagPrefix} OR canonical_uuid LIKE ${tagPrefix}`,
      );
      await db.execute(sql`DELETE FROM board_climbs WHERE uuid LIKE ${tagPrefix}`);
      await closePool();
    }
  }, 20_000);
});
