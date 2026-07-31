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
// Postgres (the dev DB). It self-skips when DATABASE_URL is not a local
// database, and runs entirely inside an outer transaction that always
// rolls back, so it never leaves rows behind. Run locally with:
//
//   DATABASE_URL=postgres://…@localhost:5432/… VITEST_POOL_ID=solo-issue3538 \
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
  const hostname = new URL(databaseUrl).hostname.toLowerCase();
  return ['localhost', '127.0.0.1', 'postgres'].includes(hostname) ? databaseUrl : null;
}

const describeIntegration = localDatabaseUrl() ? describe : describe.skip;

// A fake board_layout id — board_climbs has no FK to board_layouts, so any
// integer works here without needing a real layout fixture.
const FAKE_LAYOUT_ID = -3538;

function fakeClimb(uuid: string, name: string): NewBoardClimb {
  return {
    uuid,
    boardType: 'kilter',
    layoutId: FAKE_LAYOUT_ID,
    setterId: null,
    setterUsername: 'issue-3538-tester',
    name,
    description: '',
    characteristics: null,
    edgeLeft: null,
    edgeRight: null,
    edgeBottom: null,
    edgeTop: null,
    framesCount: 1,
    framesPace: 0,
    frames: `p1000r12`,
    isDraft: false,
    isListed: true,
    createdAt: new Date().toISOString(),
    holdFingerprint: `fp-${uuid}`,
  };
}

describeIntegration('Kilter catalog layout flush is atomic (issue #3538)', () => {
  it('lands climbs+holds+aliases together, and rolls back the whole batch on a mid-flush failure', async (testContext) => {
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

    const tag = `3538-${Date.now()}`;
    const happyUuid = `${tag}-happy`;
    const abortUuid = `${tag}-abort`;
    const missingHoldClimbUuid = `${tag}-never-inserted`;

    const rollback = new Error('rollback issue-3538 integration fixture');
    try {
      await db.transaction(async (transaction) => {
        const tx = transaction as unknown as typeof db;

        const climbCount = async (uuid: string): Promise<number> => {
          const [row] = await executeRows<{ n: number | string }>(
            tx,
            sql`SELECT count(*)::int AS n FROM board_climbs WHERE uuid = ${uuid}`,
          );
          return Number(row?.n ?? 0);
        };
        const holdCount = async (uuid: string): Promise<number> => {
          const [row] = await executeRows<{ n: number | string }>(
            tx,
            sql`SELECT count(*)::int AS n FROM board_climb_holds WHERE climb_uuid = ${uuid}`,
          );
          return Number(row?.n ?? 0);
        };
        const aliasCount = async (uuid: string): Promise<number> => {
          const [row] = await executeRows<{ n: number | string }>(
            tx,
            sql`SELECT count(*)::int AS n FROM board_climb_aliases WHERE canonical_uuid = ${uuid}`,
          );
          return Number(row?.n ?? 0);
        };

        // --- Happy path: one new canonical, one hold, one self-alias. ---
        await flushKilterLayoutBatch(
          tx,
          [fakeClimb(happyUuid, 'Issue 3538 happy path')],
          [{ boardType: 'kilter', climbUuid: happyUuid, holdId: 1000, frameNumber: 1, holdState: 'ON' }],
          [{ boardType: 'kilter', aliasUuid: happyUuid, canonicalUuid: happyUuid, source: 'kilter' }],
        );
        expect(await climbCount(happyUuid)).toBe(1);
        expect(await holdCount(happyUuid)).toBe(1);
        expect(await aliasCount(happyUuid)).toBe(1);

        // --- Atomicity path: the holds insert references a climb uuid that
        // was never inserted anywhere (not this batch, not previously) —
        // board_climb_holds_climb_fk rejects it with a real FK violation,
        // naturally simulating a mid-flush abort. Pre-fix (separate
        // autocommit statements) the climb row below would have landed
        // alone, exactly reproducing #3538. Post-fix, the whole batch must
        // roll back together.
        let sawExpectedFailure = false;
        try {
          await flushKilterLayoutBatch(
            tx,
            [fakeClimb(abortUuid, 'Issue 3538 abort path')],
            [{ boardType: 'kilter', climbUuid: missingHoldClimbUuid, holdId: 1000, frameNumber: 1, holdState: 'ON' }],
            [{ boardType: 'kilter', aliasUuid: abortUuid, canonicalUuid: abortUuid, source: 'kilter' }],
          );
        } catch {
          sawExpectedFailure = true;
        }
        expect(sawExpectedFailure).toBe(true);

        // Load-bearing assertion: the climb row for the aborted batch must
        // NOT exist. If flushKilterLayoutBatch reverts to separate awaited
        // statements, this fails (the climb row lands, orphaned).
        expect(await climbCount(abortUuid)).toBe(0);
        expect(await aliasCount(abortUuid)).toBe(0);

        // The earlier, unrelated happy-path batch is untouched by the
        // aborted one — confirms the rollback is scoped to its own batch,
        // not the whole test transaction (that's the outer fixture's job).
        expect(await climbCount(happyUuid)).toBe(1);

        throw rollback;
      });
    } catch (error: unknown) {
      if (error !== rollback) {
        throw error;
      }
    } finally {
      await closePool();
    }
  }, 20_000);
});
