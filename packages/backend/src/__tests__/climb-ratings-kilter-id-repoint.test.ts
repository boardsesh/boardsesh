import { describe, it, expect, afterEach } from 'vite-plus/test';
import { sql } from 'drizzle-orm';

import { db } from '../db/client';
import { applyClimbRatings, type PowerSyncOp } from '@boardsesh/kilter-sync';

// ---------------------------------------------------------------------------
// board_climb_ratings kilter_id reconciliation (real DB)
//
// applyClimbRatings issues ONE batched INSERT … ON CONFLICT whose target is the
// natural key (board_type, climb_uuid, angle, user_id). The table carries a
// SECOND, global unique — board_climb_ratings_kilter_id_unique, partial on
// `kilter_id IS NOT NULL`. Postgres permits exactly one conflict target per
// ON CONFLICT, so that surrogate unique was uncovered: an incoming
// climb_rating_uuid already attached to a different row raised 23505, aborted
// the ratings transaction, escaped syncKilterUserData (taking the circuits
// phase with it), and the runner classified the raw Postgres error as a
// PERMANENT failure. PowerSync re-delivers the full snapshot every cycle, so it
// failed identically forever — the kilter user sync did not complete a single
// successful run in a 30+ day window.
//
// These tests drive the REAL applyClimbRatings against a real table so the
// reconciliation is recorded behaviour, not a re-derived predicate. They only
// bite because schema-sql.ts now creates the surrogate uniques; without those
// indexes the bug is unreproducible, which is how it survived a month.
// ---------------------------------------------------------------------------

const USER_ID = 'ratings-repoint-user';
const OTHER_USER_ID = 'ratings-repoint-other-user';
const CLIMB = 'ratings-repoint-climb';
// The one byte Postgres text genuinely cannot store. Written as an escape
// rather than a literal so the character stays visible in the source.
const NUL = String.fromCharCode(0);

type RatingRow = {
  climb_uuid: string;
  angle: number;
  rating: number | null;
  comment: string | null;
  weight: number | null;
  kilter_id: string | null;
  kilter_detached_at: string | Date | null;
  updated_at: string | Date;
};

async function seedUser(id: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${`${id}@test.com`}, ${id}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);
}

/** A rating authored in Boardsesh: no kilter_id yet, carrying local-only state. */
async function seedLocalRating(userId: string, climbUuid: string, angle: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO board_climb_ratings (board_type, climb_uuid, angle, user_id, rating, comment, weight)
    VALUES ('kilter', ${climbUuid}, ${angle}, ${userId}, 4, 'local beta', 1.5)
  `);
}

async function seedKilterRating(
  userId: string,
  climbUuid: string,
  angle: number,
  kilterId: string,
  // A kilter-origin row carries the UPSTREAM rating date, not the insert time.
  // Defaulting this to now() made every fixture look newer than any realistic
  // incoming rating, which is not a shape production ever produces.
  createdAt = '2020-01-01T00:00:00.000Z',
): Promise<void> {
  await db.execute(sql`
    INSERT INTO board_climb_ratings (board_type, climb_uuid, angle, user_id, rating, kilter_id, created_at)
    VALUES ('kilter', ${climbUuid}, ${angle}, ${userId}, 3, ${kilterId}, ${createdAt})
  `);
}

async function readRatings(userId: string): Promise<RatingRow[]> {
  const result = await db.execute(sql`
    SELECT climb_uuid, angle, rating, comment, weight, kilter_id, kilter_detached_at, updated_at
    FROM board_climb_ratings
    WHERE user_id = ${userId}
    ORDER BY angle
  `);
  return Array.from(result as Iterable<RatingRow>);
}

function putOp(args: {
  climbRatingUuid: string;
  climbUuid?: string;
  angle: number;
  rating?: number;
  comment?: string;
  opId?: string;
}): PowerSyncOp {
  return {
    op_id: args.opId ?? '1',
    op: 'PUT',
    object_type: 'climb_ratings',
    object_id: args.climbRatingUuid,
    data: {
      id: args.climbRatingUuid,
      climb_rating_uuid: args.climbRatingUuid,
      user_uuid: 'kilter-sub',
      climb_uuid: args.climbUuid ?? CLIMB,
      angle: args.angle,
      rating: args.rating ?? 5,
      difficulty_grade_id: null,
      comment: args.comment ?? 'from kilter',
      created_at: '2026-05-01T12:00:00.000Z',
    },
  };
}

// Pre-seeded so resolveCanonicalClimbUuid never touches board_climb_aliases.
function aliasCacheFor(climbUuids: string[]): Map<string, string> {
  return new Map(climbUuids.map((uuid) => [`kilter:${uuid}`, uuid]));
}

type ApplyTx = Parameters<typeof applyClimbRatings>[0];
const applyTx = db as unknown as ApplyTx;

type RatingClaims = Map<string, { kilterId: string; createdAtMs: number }>;

/**
 * One flush, exactly as flushClimbRatings does it: the claims returned by a
 * call are merged into the shared map only after it resolves. Tests that merge
 * eagerly (or not at all) would not exercise the cross-flush protection they
 * are named for.
 */
async function applyFlush(batch: PowerSyncOp[], claims: RatingClaims, log: (msg: string) => void = () => {}) {
  const committed = await applyClimbRatings(applyTx, USER_ID, batch, aliasCacheFor([CLIMB]), log, claims);
  for (const [key, claim] of committed) claims.set(key, claim);
  return committed;
}

describe('applyClimbRatings kilter_id reconciliation (real DB)', () => {
  afterEach(async () => {
    await db.execute(sql`DELETE FROM board_climb_ratings WHERE user_id IN (${USER_ID}, ${OTHER_USER_ID})`);
    await db.execute(sql`DELETE FROM "users" WHERE id IN (${USER_ID}, ${OTHER_USER_ID})`);
  });

  // Guard the trap itself. If a future edit to schema-sql.ts drops this index,
  // every test below would still pass while testing nothing at all.
  it('the global partial unique on kilter_id exists in the test schema', async () => {
    const result = await db.execute(sql`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'board_climb_ratings_kilter_id_unique'
    `);
    const rows = Array.from(result as Iterable<{ indexdef: string }>);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef).toContain('UNIQUE');
    // Partial — a Boardsesh-origin rating with a NULL kilter_id must not
    // collide with every other unsynced row.
    expect(rows[0]?.indexdef).toContain('WHERE');
  });

  it('collapses two PUTs sharing one climb_rating_uuid in a single batch', async () => {
    await seedUser(USER_ID);

    // The intra-statement path. PowerSync's oplog can carry several ops for one
    // row per snapshot; an upstream angle edit re-delivers the same
    // climb_rating_uuid under a different natural key. Deduping only the
    // conflict key let both copies reach one INSERT with the same kilter_id.
    await applyClimbRatings(
      applyTx,
      USER_ID,
      [
        putOp({ climbRatingUuid: 'kr-dupe', angle: 40, opId: '1' }),
        putOp({ climbRatingUuid: 'kr-dupe', angle: 25, opId: '2' }),
      ],
      aliasCacheFor([CLIMB]),
      () => {},
    );

    // Last op wins: the rating lives at its current upstream angle, once.
    const rows = await readRatings(USER_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.angle).toBe(25);
    expect(rows[0]?.kilter_id).toBe('kr-dupe');
  });

  it('repoints a kilter_id that moved to a different angle across cycles', async () => {
    await seedUser(USER_ID);
    await applyClimbRatings(
      applyTx,
      USER_ID,
      [putOp({ climbRatingUuid: 'kr-move', angle: 40 })],
      aliasCacheFor([CLIMB]),
      () => {},
    );

    // Cycle two: upstream moved the same rating to angle 25.
    await applyClimbRatings(
      applyTx,
      USER_ID,
      [putOp({ climbRatingUuid: 'kr-move', angle: 25 })],
      aliasCacheFor([CLIMB]),
      () => {},
    );

    const rows = await readRatings(USER_ID);
    expect(rows).toHaveLength(2);
    const moved = rows.find((row) => row.angle === 25);
    const stale = rows.find((row) => row.angle === 40);

    expect(moved?.kilter_id).toBe('kr-move');
    expect(moved?.kilter_detached_at).toBeNull();

    // The stale row is DETACHED, never deleted — it keeps its rating data and
    // only loses the surrogate.
    expect(stale).toBeDefined();
    expect(stale?.kilter_id).toBeNull();
    // The marker is load-bearing: push-back selects on
    // `kilter_id IS NULL AND kilter_detached_at IS NULL`, so an unmarked stale
    // row would look never-pushed and get re-created upstream as a duplicate.
    expect(stale?.kilter_detached_at).not.toBeNull();
  });

  it('repoints onto a Boardsesh-origin row without losing its local-only state', async () => {
    await seedUser(USER_ID);
    // The DO UPDATE branch trips the surrogate unique too — it writes kilter_id
    // through COALESCE — so this is a distinct path from the INSERT branch.
    await seedLocalRating(USER_ID, CLIMB, 25);
    await applyClimbRatings(
      applyTx,
      USER_ID,
      [putOp({ climbRatingUuid: 'kr-adopt', angle: 40 })],
      aliasCacheFor([CLIMB]),
      () => {},
    );

    await applyClimbRatings(
      applyTx,
      USER_ID,
      [putOp({ climbRatingUuid: 'kr-adopt', angle: 25 })],
      aliasCacheFor([CLIMB]),
      () => {},
    );

    const rows = await readRatings(USER_ID);
    const adopted = rows.find((row) => row.angle === 25);
    expect(adopted?.kilter_id).toBe('kr-adopt');
    // `weight` is outside the upsert's SET clause and Kilter never sends one —
    // it only survives if the row survived rather than being re-inserted.
    expect(Number(adopted?.weight)).toBe(1.5);
  });

  it('swaps two kilter_ids between two rows in one batch', async () => {
    await seedUser(USER_ID);
    await seedKilterRating(USER_ID, CLIMB, 40, 'kr-a');
    await seedKilterRating(USER_ID, CLIMB, 25, 'kr-b');

    // Both detaches must land before either upsert; interleaving them per row
    // re-introduces the collision.
    await applyClimbRatings(
      applyTx,
      USER_ID,
      [putOp({ climbRatingUuid: 'kr-a', angle: 25 }), putOp({ climbRatingUuid: 'kr-b', angle: 40 })],
      aliasCacheFor([CLIMB]),
      () => {},
    );

    const rows = await readRatings(USER_ID);
    expect(rows.find((row) => row.angle === 25)?.kilter_id).toBe('kr-a');
    expect(rows.find((row) => row.angle === 40)?.kilter_id).toBe('kr-b');
  });

  it('never steals a kilter_id owned by a different Boardsesh user', async () => {
    await seedUser(USER_ID);
    await seedUser(OTHER_USER_ID);
    // One Kilter account linked to two Boardsesh accounts.
    await seedKilterRating(OTHER_USER_ID, CLIMB, 40, 'kr-shared');

    const logged: string[] = [];
    await applyClimbRatings(
      applyTx,
      USER_ID,
      [putOp({ climbRatingUuid: 'kr-shared', angle: 40 })],
      aliasCacheFor([CLIMB]),
      (msg) => logged.push(msg),
    );

    // The other user's row is untouched, and we did not write our own.
    const otherRows = await readRatings(OTHER_USER_ID);
    expect(otherRows).toHaveLength(1);
    expect(otherRows[0]?.kilter_id).toBe('kr-shared');
    expect(otherRows[0]?.kilter_detached_at).toBeNull();
    expect(await readRatings(USER_ID)).toHaveLength(0);
    // Skip-and-log, so the duplicate-account link stays visible.
    expect(logged.join('\n')).toContain('different Boardsesh user');
  });

  it('leaves a steady-state re-sync untouched', async () => {
    await seedUser(USER_ID);
    const ops = [putOp({ climbRatingUuid: 'kr-steady', angle: 40 })];
    await applyClimbRatings(applyTx, USER_ID, ops, aliasCacheFor([CLIMB]), () => {});
    const first = (await readRatings(USER_ID))[0];

    // PowerSync re-delivers the full snapshot every cycle. Nothing changed, so
    // nothing should be detached and updated_at must not drift into "when the
    // sync last ran".
    const logged: string[] = [];
    await applyClimbRatings(applyTx, USER_ID, ops, aliasCacheFor([CLIMB]), (msg) => logged.push(msg));

    const second = (await readRatings(USER_ID))[0];
    expect(second?.kilter_id).toBe('kr-steady');
    expect(second?.kilter_detached_at).toBeNull();
    expect(new Date(second!.updated_at).getTime()).toBe(new Date(first!.updated_at).getTime());
    expect(logged.join('\n')).not.toContain('repointing');
  });

  it('logs when it replaces a different kilter_id already on the natural-key row', async () => {
    await seedUser(USER_ID);
    // The row Kilter is about to re-identify: same climb+angle, different
    // surrogate. The upsert replaces kilter_id through COALESCE, which is
    // intended — the natural key is the identity — but must not be silent.
    await seedKilterRating(USER_ID, CLIMB, 40, 'kr-old');

    const logged: string[] = [];
    await applyClimbRatings(
      applyTx,
      USER_ID,
      [putOp({ climbRatingUuid: 'kr-new', angle: 40 })],
      aliasCacheFor([CLIMB]),
      (msg) => logged.push(msg),
    );

    const rows = await readRatings(USER_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kilter_id).toBe('kr-new');
    // The log is summarised (a count plus a bounded sample) rather than one
    // line per row: the per-row form produced ~700 lines per sync for a single
    // production account, which buries the signal it exists to provide.
    const divergence = logged.find((line) => line.includes('replacing kilter_id on'));
    expect(divergence).toBeDefined();
    expect(divergence).toContain('1 rating(s)');
    // The sample must still name both surrogates, or the line reports that
    // drift happened without saying what changed.
    expect(divergence).toContain('kr-old->kr-new');
  });

  it('picks the same winner regardless of the order two upstream ratings arrive in', async () => {
    // Two upstream ratings collapsing onto one natural key is a real upstream
    // condition, not a corner case: one production account had 254 of them.
    // PowerSync gives no stable op order between snapshots, so a last-op-wins
    // dedupe flips the winner every cycle — kilter_id genuinely changes, the
    // setWhere guard fires, updated_at churns, and the pair ping-pongs forever.
    // The winner must be a function of the DATA, not of arrival order.
    await seedUser(USER_ID);
    const older = putOp({ climbRatingUuid: 'kr-older', angle: 40, opId: '1' });
    const newer = putOp({ climbRatingUuid: 'kr-newer', angle: 40, opId: '2' });
    (newer.data as Record<string, unknown>).created_at = '2026-06-01T12:00:00.000Z';

    await applyClimbRatings(applyTx, USER_ID, [older, newer], aliasCacheFor([CLIMB]), () => {});
    const forward = (await readRatings(USER_ID))[0]?.kilter_id;

    await db.execute(sql`DELETE FROM board_climb_ratings WHERE user_id = ${USER_ID}`);

    // Same batch, reversed. A last-op-wins implementation returns 'kr-older' here.
    await applyClimbRatings(applyTx, USER_ID, [newer, older], aliasCacheFor([CLIMB]), () => {});
    const reversed = (await readRatings(USER_ID))[0]?.kilter_id;

    expect(forward).toBe('kr-newer');
    expect(reversed).toBe('kr-newer');
  });

  it('does not churn updated_at when a duplicate pair re-arrives in the other order', async () => {
    await seedUser(USER_ID);
    const older = putOp({ climbRatingUuid: 'kr-older', angle: 40, opId: '1' });
    const newer = putOp({ climbRatingUuid: 'kr-newer', angle: 40, opId: '2' });
    (newer.data as Record<string, unknown>).created_at = '2026-06-01T12:00:00.000Z';

    await applyClimbRatings(applyTx, USER_ID, [older, newer], aliasCacheFor([CLIMB]), () => {});
    const first = (await readRatings(USER_ID))[0];

    // The next snapshot delivers the same two rows in the opposite order. With
    // a stable winner nothing changes, so the setWhere guard suppresses the
    // UPDATE entirely and the row is not re-shipped to offline clients.
    await applyClimbRatings(applyTx, USER_ID, [newer, older], aliasCacheFor([CLIMB]), () => {});
    const second = (await readRatings(USER_ID))[0];

    expect(second?.kilter_id).toBe(first?.kilter_id);
    expect(new Date(second!.updated_at).getTime()).toBe(new Date(first!.updated_at).getTime());
  });

  it("does not let a later flush undo an earlier flush's newer pick", async () => {
    // The bug a single-batch test cannot see. Duplicates for one climb/angle
    // that land in DIFFERENT flushes were both written, and the later flush
    // won regardless of which rating was newer — so the choice never
    // converged and updated_at churned on every sync forever.
    await seedUser(USER_ID);
    const newer = putOp({ climbRatingUuid: 'kr-newer', angle: 40 });
    (newer.data as Record<string, unknown>).created_at = '2026-06-01T12:00:00.000Z';
    const older = putOp({ climbRatingUuid: 'kr-older', angle: 40 });

    // One shared map = one sync; two calls = two flushes.
    const claimed: RatingClaims = new Map();
    await applyFlush([newer], claimed);
    await applyFlush([older], claimed);

    const rows = await readRatings(USER_ID);
    expect(rows).toHaveLength(1);
    // The newer rating from flush 1 survives; the older one in flush 2 is
    // skipped rather than overwriting it.
    expect(rows[0]?.kilter_id).toBe('kr-newer');
  });

  it('carries the flush claim across a whole sync without churning updated_at', async () => {
    await seedUser(USER_ID);
    const newer = putOp({ climbRatingUuid: 'kr-newer', angle: 40 });
    (newer.data as Record<string, unknown>).created_at = '2026-06-01T12:00:00.000Z';
    const older = putOp({ climbRatingUuid: 'kr-older', angle: 40 });

    const syncOne: RatingClaims = new Map();
    await applyFlush([newer], syncOne);
    await applyFlush([older], syncOne);
    const first = (await readRatings(USER_ID))[0];

    // A second sync sees the same snapshot again. Nothing should move, which
    // is what "converged" means: no UPDATE, no re-ship to offline clients.
    const syncTwo: RatingClaims = new Map();
    await applyFlush([newer], syncTwo);
    await applyFlush([older], syncTwo);
    const second = (await readRatings(USER_ID))[0];

    expect(second?.kilter_id).toBe('kr-newer');
    expect(new Date(second!.updated_at).getTime()).toBe(new Date(first!.updated_at).getTime());
  });

  it('does not keep a flush claim when the transaction rolls back', async () => {
    // The claim map is consulted by later flushes in the same sync to avoid
    // undoing an earlier, newer pick. applyClimbRatings runs INSIDE
    // db.transaction, so a claim recorded during the call would outlive a
    // rollback that discarded the write it describes — and the next flush would
    // then skip that climb/angle as "already claimed", leaving no row at all.
    //
    // This is reachable, not theoretical: a failing flush is caught by runPhase
    // and the sync continues to the next one.
    await seedUser(USER_ID);
    const claimed: RatingClaims = new Map();

    const newer = putOp({ climbRatingUuid: 'kr-rolledback', angle: 40 });
    (newer.data as Record<string, unknown>).created_at = '2026-06-01T12:00:00.000Z';

    // Flush 1 applies cleanly and is then rolled back by an unrelated failure.
    await expect(
      db.transaction(async (tx) => {
        await applyClimbRatings(tx as unknown as ApplyTx, USER_ID, [newer], aliasCacheFor([CLIMB]), () => {}, claimed);
        throw new Error('simulated failure after the write');
      }),
    ).rejects.toThrow('simulated failure');

    // Nothing was written, so nothing may be claimed.
    expect(await readRatings(USER_ID)).toHaveLength(0);
    expect(claimed.size).toBe(0);

    // Flush 2 carries an OLDER rating for the same climb/angle. If the rolled
    // back claim had survived, this would be skipped as already-claimed and the
    // user would end up with no rating for this climb at all.
    const older = putOp({ climbRatingUuid: 'kr-after-rollback', angle: 40 });
    await applyFlush([older], claimed);

    const rows = await readRatings(USER_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kilter_id).toBe('kr-after-rollback');
    expect(claimed.size).toBe(1);
  });

  it('leaves a stored newer rating alone when an older one arrives', async () => {
    // The residual churn after the cross-flush fix. A duplicate pair split
    // across flushes leaves the EARLIER flush holding only the older candidate.
    // Without comparing against what is stored it writes anyway, and the later
    // flush corrects it — one wasted UPDATE and one updated_at bump per key per
    // sync, forever. Measured at 369 per run on a production account.
    await seedUser(USER_ID);

    // Establish the newer rating as the stored one.
    const newer = putOp({ climbRatingUuid: 'kr-newer', angle: 40 });
    (newer.data as Record<string, unknown>).created_at = '2026-06-01T12:00:00.000Z';
    await applyFlush([newer], new Map());
    const before = (await readRatings(USER_ID))[0];
    expect(before?.kilter_id).toBe('kr-newer');

    // A later sync whose first flush carries only the older duplicate.
    const older = putOp({ climbRatingUuid: 'kr-older', angle: 40 });
    const logged: string[] = [];
    await applyFlush([older], new Map(), (msg) => logged.push(msg));

    const after = (await readRatings(USER_ID))[0];
    expect(after?.kilter_id).toBe('kr-newer');
    // No write at all, so no updated_at bump and nothing re-shipped to clients.
    expect(new Date(after!.updated_at).getTime()).toBe(new Date(before!.updated_at).getTime());
    expect(logged.join('\n')).toContain('older than the stored rating');
  });

  it('still replaces the stored rating when the incoming one is genuinely newer', async () => {
    // The guard must not become "never update". An upstream rating that really
    // is newer has to win, or a re-rated climb would freeze at its first value.
    await seedUser(USER_ID);
    const older = putOp({ climbRatingUuid: 'kr-older', angle: 40 });
    await applyFlush([older], new Map());

    const newer = putOp({ climbRatingUuid: 'kr-newer', angle: 40, rating: 2 });
    (newer.data as Record<string, unknown>).created_at = '2026-06-01T12:00:00.000Z';
    await applyFlush([newer], new Map());

    const rows = await readRatings(USER_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kilter_id).toBe('kr-newer');
    expect(rows[0]?.rating).toBe(2);
  });

  it('still swaps when the incumbent rating is itself being relocated', async () => {
    // The stale-candidate guard must not block an upstream swap. Both ratings
    // trade climb/angle in one batch, so each incumbent is vacating its key —
    // deferring to it would apply half the swap and wedge the pair. An earlier
    // version of the guard did exactly that, and only the real-DB swap test
    // caught it.
    await seedUser(USER_ID);
    await seedKilterRating(USER_ID, CLIMB, 40, 'kr-a', '2021-01-01T00:00:00.000Z');
    // Deliberately NEWER than the incoming ops, so the guard would skip it if it
    // did not notice kr-b is moving too.
    await seedKilterRating(USER_ID, CLIMB, 25, 'kr-b', '2030-01-01T00:00:00.000Z');

    await applyFlush(
      [putOp({ climbRatingUuid: 'kr-a', angle: 25 }), putOp({ climbRatingUuid: 'kr-b', angle: 40 })],
      new Map(),
    );

    const rows = await readRatings(USER_ID);
    expect(rows.find((row) => row.angle === 25)?.kilter_id).toBe('kr-a');
    expect(rows.find((row) => row.angle === 40)?.kilter_id).toBe('kr-b');
  });

  it('skips a row Postgres refuses instead of losing the whole batch', async () => {
    await seedUser(USER_ID);

    // A NUL byte is the one thing Postgres text genuinely cannot store, so it
    // stands in for any row shape we failed to anticipate. Before the per-chunk
    // savepoint and row-by-row replay, one such row aborted the transaction,
    // failed the user permanently, and skipped the circuits phase.
    await applyClimbRatings(
      applyTx,
      USER_ID,
      [
        putOp({ climbRatingUuid: 'kr-ok-1', angle: 40 }),
        putOp({ climbRatingUuid: 'kr-poison', angle: 30, comment: `bad${NUL}byte` }),
        putOp({ climbRatingUuid: 'kr-ok-2', angle: 25 }),
      ],
      aliasCacheFor([CLIMB]),
      () => {},
    );

    const rows = await readRatings(USER_ID);
    expect(rows.map((row) => row.kilter_id).sort((left, right) => String(left).localeCompare(String(right)))).toEqual([
      'kr-ok-1',
      'kr-ok-2',
    ]);
  });
});
