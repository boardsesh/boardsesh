import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { setupWorkerDatabase } from './worker-db';

// Both recompute paths ARE under test here — a tick that lands on the canonical
// but recomputes the retired key would leave the canonical's stats untouched —
// so they are mocked to be observable, not to be silenced.
const { queueClimbStatsRecomputeMock, recomputeClimbStatsNowMock, inlineRecomputeSettled } = vi.hoisted(() => {
  const inlineRecomputeSettled = { value: false };
  return {
    inlineRecomputeSettled,
    queueClimbStatsRecomputeMock: vi.fn((_boardType: string, _climbUuid: string, _angle: number) => undefined),
    // Settles on a macrotask, not a microtask: a saveTick that forgot to await
    // this would resolve before the flag flips, so the flag is what proves the
    // await — call-count and call-order assertions cannot tell the two apart.
    recomputeClimbStatsNowMock: vi.fn(async (_boardType: string, _climbUuid: string, _angle: number) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      inlineRecomputeSettled.value = true;
    }),
  };
});
vi.mock('../graphql/resolvers/ticks/debounced-climb-stats-publisher', () => ({
  queueClimbStatsRecompute: queueClimbStatsRecomputeMock,
  recomputeClimbStatsNow: recomputeClimbStatsNowMock,
}));

// Side effects saveTick fires after the insert; none of them are under test and
// they would otherwise pull in Redis / the social event bus.
vi.mock('../events', () => ({ publishSocialEvent: vi.fn(async () => undefined) }));
vi.mock('../graphql/resolvers/sessions/debounced-stats-publisher', () => ({
  publishDebouncedSessionStats: vi.fn(),
}));
vi.mock('../graphql/resolvers/board-presence/stats', () => ({ queueBoardStatsPublish: vi.fn() }));
vi.mock('../services/analytics/posthog', () => ({ captureBackendEvent: vi.fn(() => true) }));

import { db } from '../db/client';
import { tickMutations } from '../graphql/resolvers/ticks/mutations';

const USER_ID = 'u-alias-resolution';
const BOARD = 'moonboard';

// Prefixed so cleanup can't touch a neighbouring suite's fixtures —
// board_climb_aliases is NOT in the shared TRUNCATE list.
const PREFIX = 'ALIASRES-';
const CANONICAL = `${PREFIX}CANONICAL`;
const RETIRED = `${PREFIX}RETIRED`;
const SELF_ALIASED = `${PREFIX}SELF-ALIASED`;
const UNALIASED = `${PREFIX}UNALIASED`;

function authCtx(): ConnectionContext {
  return {
    connectionId: `conn-${Math.random().toString(36).slice(2)}`,
    isAuthenticated: true,
    userId: USER_ID,
  } as ConnectionContext;
}

function tickInput(climbUuid: string) {
  return {
    boardType: BOARD,
    climbUuid,
    angle: 40,
    isMirror: false,
    status: 'send',
    attemptCount: 1,
    quality: 4,
    difficulty: 17,
    isBenchmark: false,
    comment: '',
    climbedAt: new Date().toISOString(),
  };
}

async function storedClimbUuids(): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT climb_uuid FROM boardsesh_ticks WHERE user_id = ${USER_ID} ORDER BY climb_uuid
  `)) as unknown as Array<{ climb_uuid: string }>;
  const list = Array.isArray(rows) ? rows : (rows as { rows: Array<{ climb_uuid: string }> }).rows;
  return list.map((row) => row.climb_uuid);
}

/**
 * A tick must land on the climb the catalog still lists, not on whatever UUID
 * the client was holding.
 *
 * MoonBoard's angle-dedup migration retires one catalog UUID per merged
 * problem and records the mapping in board_climb_aliases. Phones carry an
 * offline board catalog and only learn a climb was retired on their next pull,
 * and the offline drainer replays queued sends against whatever UUID they were
 * logged with — so retired-UUID ticks keep arriving after the migration
 * commits. Every read path resolves alias -> canonical FORWARD and never
 * tick -> canonical backward, so a tick stored under a retired UUID is
 * invisible on the climb page and absent from its stats.
 */
describe('saveTick resolves an alias-borne climb UUID to the canonical', () => {
  beforeAll(async () => {
    await setupWorkerDatabase();

    await db.execute(sql`
      INSERT INTO users (id, email, name, created_at, updated_at)
      VALUES (${USER_ID}, ${`${USER_ID}@test.com`}, 'Ally Ass', now(), now())
      ON CONFLICT (id) DO NOTHING
    `);
    for (const uuid of [CANONICAL, RETIRED, SELF_ALIASED, UNALIASED]) {
      await db.execute(sql`
        INSERT INTO board_climbs (uuid, board_type, layout_id, setter_username, name, description, frames, is_listed)
        VALUES (${uuid}, ${BOARD}, 1, 'setter', 'Test Climb', '', 'p1r1', true)
        ON CONFLICT (uuid) DO NOTHING
      `);
    }
    // Exactly what the dedup migration leaves behind: the retired row stays in
    // board_climbs (delisted, never deleted) with an alias pointing at the
    // survivor, plus the survivor's own self-alias that the catalog importer
    // writes for every climb.
    await db.execute(sql`
      UPDATE board_climbs SET is_listed = false WHERE uuid = ${RETIRED}
    `);
    await db.execute(sql`
      INSERT INTO board_climb_aliases (board_type, alias_uuid, canonical_uuid, source)
      VALUES
        (${BOARD}, ${RETIRED}, ${CANONICAL}, 'moonboard-angle-dedup'),
        (${BOARD}, ${SELF_ALIASED}, ${SELF_ALIASED}, 'moonboard-catalog-import')
      ON CONFLICT (board_type, alias_uuid) DO NOTHING
    `);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM boardsesh_ticks WHERE user_id = ${USER_ID}`);
    await db.execute(sql`DELETE FROM board_climb_aliases WHERE alias_uuid LIKE ${`${PREFIX}%`}`);
    await db.execute(sql`DELETE FROM board_climbs WHERE uuid LIKE ${`${PREFIX}%`}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${USER_ID}`);
  });

  beforeEach(() => {
    queueClimbStatsRecomputeMock.mockClear();
    recomputeClimbStatsNowMock.mockClear();
    inlineRecomputeSettled.value = false;
  });

  afterEach(async () => {
    await db.execute(sql`DELETE FROM boardsesh_ticks WHERE user_id = ${USER_ID}`);
  });

  it('stores a tick sent against a retired UUID under the canonical UUID', async () => {
    const result = (await tickMutations.saveTick(undefined, { input: tickInput(RETIRED) }, authCtx())) as {
      climbUuid: string;
    };

    expect(result.climbUuid).toBe(CANONICAL);
    expect(await storedClimbUuids()).toEqual([CANONICAL]);
  });

  // Landing the row on the canonical is only half of it: the recompute has to
  // fire for the canonical's key too, or the ascent is in the table and still
  // missing from the number every surface reads.
  it('recomputes the canonical key, not the retired one', async () => {
    await tickMutations.saveTick(undefined, { input: tickInput(RETIRED) }, authCtx());

    expect(queueClimbStatsRecomputeMock).toHaveBeenCalledTimes(1);
    expect(queueClimbStatsRecomputeMock).toHaveBeenCalledWith(BOARD, CANONICAL, 40);
  });

  // #4798: the client invalidates its climb lists as soon as saveTick resolves,
  // so the refetch races the 2s debounce. The inline recompute has to have run —
  // and run BEFORE the queue call — or that refetch reads a stats row this tick
  // has not reached yet, which at a brand-new angle means no row and no grade.
  it('recomputes the canonical key inline, before queueing the debounced pass', async () => {
    await tickMutations.saveTick(undefined, { input: tickInput(RETIRED) }, authCtx());

    expect(recomputeClimbStatsNowMock).toHaveBeenCalledTimes(1);
    expect(recomputeClimbStatsNowMock).toHaveBeenCalledWith(BOARD, CANONICAL, 40);
    expect(recomputeClimbStatsNowMock.mock.invocationCallOrder[0]).toBeLessThan(
      queueClimbStatsRecomputeMock.mock.invocationCallOrder[0],
    );
    // The mutation must have AWAITED the inline recompute, not just started it.
    expect(inlineRecomputeSettled.value).toBe(true);
  });

  it('leaves a UUID with no alias row exactly as the client sent it', async () => {
    const result = (await tickMutations.saveTick(undefined, { input: tickInput(UNALIASED) }, authCtx())) as {
      climbUuid: string;
    };

    expect(result.climbUuid).toBe(UNALIASED);
    expect(await storedClimbUuids()).toEqual([UNALIASED]);
    expect(queueClimbStatsRecomputeMock).toHaveBeenCalledWith(BOARD, UNALIASED, 40);
  });

  // Every MoonBoard catalog climb carries a self-alias, so this is the common
  // path, not an edge case: resolution must be a no-op on it rather than a
  // round-trip that changes something.
  it('is a no-op for a climb whose only alias row points at itself', async () => {
    const result = (await tickMutations.saveTick(undefined, { input: tickInput(SELF_ALIASED) }, authCtx())) as {
      climbUuid: string;
    };

    expect(result.climbUuid).toBe(SELF_ALIASED);
    expect(await storedClimbUuids()).toEqual([SELF_ALIASED]);
  });

  // The alias table is keyed on (board_type, alias_uuid), so a Kilter UUID that
  // happens to match a MoonBoard alias must not be rewritten. Dropping the
  // board_type predicate from the resolver would cross-link two catalogs.
  it('does not resolve an alias recorded under a different board type', async () => {
    const result = (await tickMutations.saveTick(
      undefined,
      { input: { ...tickInput(RETIRED), boardType: 'kilter' } },
      authCtx(),
    )) as { climbUuid: string };

    expect(result.climbUuid).toBe(RETIRED);
    expect(await storedClimbUuids()).toEqual([RETIRED]);
  });
});
