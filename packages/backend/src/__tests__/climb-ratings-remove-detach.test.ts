import { describe, it, expect, afterEach, vi } from 'vite-plus/test';
import { sql } from 'drizzle-orm';

import { db } from '../db/client';
import { applyClimbRatings, pushKilterUserData, type PowerSyncOp } from '@boardsesh/kilter-sync';

// ---------------------------------------------------------------------------
// board_climb_ratings REMOVE soft-detach (real DB) — #3525
//
// applyClimbRatings used to hard-DELETE on REMOVE, on the theory that
// `kilter_id IN (removeIds)` can only match kilter-origin rows. It can't: the
// upsert in the same function adopts a kilter_id onto a pre-existing
// Boardsesh-origin row (its conflict target is the natural key, not kilter_id),
// so an adopted row matched the DELETE and the whole row went with it —
// including `weight`, which a Kilter PUT always writes as null and can never
// restore. PowerSync re-delivers full snapshots as REMOVE-before-PUT for every
// row, so this fired on ordinary reconnects, not just genuine deletes.
//
// The fix detaches instead: kilter_id NULL + kilter_detached_at stamped. These
// tests drive the REAL applyClimbRatings against a real table, so the DELETE →
// UPDATE change is exercised as recorded behaviour rather than a re-derived
// predicate.
// ---------------------------------------------------------------------------

const TEST_USER_ID = 'ratings-detach-user';
const CLIMB_PREFIX = 'ratings-detach-climb-';
const ANGLE = 40;

type RatingRow = {
  rating: number | null;
  comment: string | null;
  weight: number | null;
  kilter_id: string | null;
  // Raw driver output: postgres.js hands timestamps back as strings here, so
  // don't assume a Date instance — normalise before comparing.
  kilter_detached_at: string | Date | null;
  updated_at: string | Date;
};

async function seedUser(): Promise<void> {
  await db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${TEST_USER_ID}, ${`${TEST_USER_ID}@test.com`}, ${TEST_USER_ID}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);
}

/** A rating authored in Boardsesh: no kilter_id yet, carrying local-only state. */
async function seedLocalRating(climbUuid: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO board_climb_ratings (board_type, climb_uuid, angle, user_id, rating, comment, weight)
    VALUES ('kilter', ${climbUuid}, ${ANGLE}, ${TEST_USER_ID}, 4, 'local beta', 1.5)
  `);
}

async function readRating(climbUuid: string): Promise<RatingRow | undefined> {
  const result = await db.execute(sql`
    SELECT rating, comment, weight, kilter_id, kilter_detached_at, updated_at
    FROM board_climb_ratings
    WHERE user_id = ${TEST_USER_ID} AND climb_uuid = ${climbUuid} AND angle = ${ANGLE}
  `);
  return Array.from(result as Iterable<RatingRow>)[0];
}

function putOp(args: { climbRatingUuid: string; climbUuid: string; rating: number; comment?: string }): PowerSyncOp {
  return {
    op_id: '1',
    op: 'PUT',
    object_type: 'climb_ratings',
    object_id: args.climbRatingUuid,
    data: {
      id: args.climbRatingUuid,
      climb_rating_uuid: args.climbRatingUuid,
      user_uuid: 'kilter-sub',
      climb_uuid: args.climbUuid,
      angle: ANGLE,
      rating: args.rating,
      difficulty_grade_id: null,
      comment: args.comment ?? 'from kilter',
      created_at: '2026-05-01T12:00:00.000Z',
    },
  };
}

function removeOp(climbRatingUuid: string): PowerSyncOp {
  return { op_id: '2', op: 'REMOVE', object_type: 'climb_ratings', object_id: climbRatingUuid };
}

// Pre-seeded so resolveCanonicalClimbUuid never touches board_climb_aliases:
// these fixture uuids ARE their own canonical.
function aliasCacheFor(climbUuids: string[]): Map<string, string> {
  return new Map(climbUuids.map((uuid) => [`kilter:${uuid}`, uuid]));
}

type ApplyTx = Parameters<typeof applyClimbRatings>[0];
const applyTx = db as unknown as ApplyTx;

describe('applyClimbRatings REMOVE → soft-detach (real DB)', () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    await db.execute(sql`DELETE FROM board_climb_ratings WHERE user_id = ${TEST_USER_ID}`);
    await db.execute(sql`DELETE FROM "users" WHERE id = ${TEST_USER_ID}`);
  });

  it('a PUT adopts a kilter_id onto a Boardsesh-origin rating and leaves its weight alone', async () => {
    const climbUuid = CLIMB_PREFIX + 'adopt';
    await seedUser();
    await seedLocalRating(climbUuid);

    await applyClimbRatings(
      applyTx,
      TEST_USER_ID,
      [putOp({ climbRatingUuid: 'kr-adopt', climbUuid, rating: 5 })],
      aliasCacheFor([climbUuid]),
      () => {},
    );

    const row = await readRating(climbUuid);
    // The adoption itself: one row, now carrying Kilter's surrogate key. This
    // is what makes the old `kilter_id IN (…)` DELETE unsafe.
    expect(row?.kilter_id).toBe('kr-adopt');
    expect(row?.rating).toBe(5);
    // `weight` is outside the upsert's SET clause and Kilter's payload never
    // carries one — it only survives if the row itself survives.
    expect(Number(row?.weight)).toBe(1.5);
    expect(row?.kilter_detached_at).toBeNull();
  });

  it('a REMOVE for an adopted rating keeps the row and marks it detached', async () => {
    const climbUuid = CLIMB_PREFIX + 'remove';
    await seedUser();
    await seedLocalRating(climbUuid);
    await applyClimbRatings(
      applyTx,
      TEST_USER_ID,
      [putOp({ climbRatingUuid: 'kr-remove', climbUuid, rating: 5 })],
      aliasCacheFor([climbUuid]),
      () => {},
    );

    await applyClimbRatings(applyTx, TEST_USER_ID, [removeOp('kr-remove')], new Map(), () => {});

    // On main this row is gone — the DELETE matched the adopted kilter_id.
    const row = await readRating(climbUuid);
    expect(row).toBeDefined();
    expect(Number(row?.weight)).toBe(1.5);
    expect(row?.rating).toBe(5);
    expect(row?.kilter_id).toBeNull();
    expect(row?.kilter_detached_at).not.toBeNull();
  });

  it('a REMOVE-then-PUT snapshot redelivery re-adopts the row and clears the marker', async () => {
    const climbUuid = CLIMB_PREFIX + 'redeliver';
    await seedUser();
    await seedLocalRating(climbUuid);
    await applyClimbRatings(
      applyTx,
      TEST_USER_ID,
      [putOp({ climbRatingUuid: 'kr-redeliver', climbUuid, rating: 5 })],
      aliasCacheFor([climbUuid]),
      () => {},
    );
    await applyClimbRatings(applyTx, TEST_USER_ID, [removeOp('kr-redeliver')], new Map(), () => {});
    const detached = await readRating(climbUuid);
    expect(detached?.kilter_detached_at).not.toBeNull();

    // Jump the clock so the re-adoption cannot land in the same millisecond as
    // the detach. applyClimbRatings stamps updated_at from this process's
    // `new Date()`, so faking Date alone is enough (and faking only Date keeps
    // the postgres driver's real timers intact). Without this the assertion
    // below is a coin flip: both writes routinely land in one millisecond.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() + 60_000));

    // PowerSync sends REMOVE before PUT for every row in a re-delivered
    // snapshot, so the row has to come back fully live — a permanent marker
    // would hide it from the ascents feed forever.
    await applyClimbRatings(
      applyTx,
      TEST_USER_ID,
      [putOp({ climbRatingUuid: 'kr-redeliver', climbUuid, rating: 3 })],
      aliasCacheFor([climbUuid]),
      () => {},
    );

    const row = await readRating(climbUuid);
    expect(row?.kilter_id).toBe('kr-redeliver');
    expect(row?.kilter_detached_at).toBeNull();
    expect(row?.rating).toBe(3);
    expect(Number(row?.weight)).toBe(1.5);
    // The re-adoption bumps updated_at past the detach, so a cursor-based
    // consumer can see the transition. Strict `>`: if the upsert stopped
    // writing updated_at the column would still hold the detach timestamp.
    expect(new Date(row!.updated_at).getTime()).toBeGreaterThan(new Date(detached!.updated_at).getTime());
  });

  it('a REMOVE for a purely kilter-origin rating detaches it rather than deleting it', async () => {
    const climbUuid = CLIMB_PREFIX + 'pure-kilter';
    await seedUser();
    // Never authored locally: the row is created by the PUT itself.
    await applyClimbRatings(
      applyTx,
      TEST_USER_ID,
      [putOp({ climbRatingUuid: 'kr-pure', climbUuid, rating: 2 })],
      aliasCacheFor([climbUuid]),
      () => {},
    );

    await applyClimbRatings(applyTx, TEST_USER_ID, [removeOp('kr-pure')], new Map(), () => {});

    // Deliberate behaviour change, matching the tick precedent: the row stays
    // but is marked. The ascents feeds filter on kilter_detached_at, so the
    // deleted rating stops showing up (see tick-queries.test.ts).
    const row = await readRating(climbUuid);
    expect(row).toBeDefined();
    expect(row?.kilter_id).toBeNull();
    expect(row?.kilter_detached_at).not.toBeNull();
  });

  // The echo-loop guard, exercised through the real exported entry point so the
  // WHERE predicate runs against Postgres instead of being re-derived here.
  // Nothing can actually reach Kilter yet — pushPendingRatings calls
  // pushNotWired('POST /api/climb-rating/') before any request — which is
  // exactly what makes it a usable oracle: reaching the throw means the row was
  // selected for push.
  describe('push-back skips detached ratings', () => {
    it('a rating with kilter_id NULL and no marker IS selected for push', async () => {
      const climbUuid = CLIMB_PREFIX + 'push-live';
      await seedUser();
      await seedLocalRating(climbUuid);
      vi.stubEnv('KILTER_SYNC_PUSH_ENABLED', 'true');

      // Positive control: without this, "resolves" below would prove nothing —
      // the select has to be capable of picking the row up in the first place.
      await expect(pushKilterUserData({ db, userId: TEST_USER_ID, accessToken: 'test-token' })).rejects.toThrowError(
        /POST \/api\/climb-rating\//,
      );
    });

    it('a detached rating is NOT selected for push', async () => {
      const climbUuid = CLIMB_PREFIX + 'push-detached';
      await seedUser();
      await seedLocalRating(climbUuid);
      await applyClimbRatings(
        applyTx,
        TEST_USER_ID,
        [putOp({ climbRatingUuid: 'kr-push', climbUuid, rating: 5 })],
        aliasCacheFor([climbUuid]),
        () => {},
      );
      await applyClimbRatings(applyTx, TEST_USER_ID, [removeOp('kr-push')], new Map(), () => {});
      vi.stubEnv('KILTER_SYNC_PUSH_ENABLED', 'true');

      // Same shape as the control above, minus the marker: drop the
      // isNull(kilterDetachedAt) predicate and this throws instead.
      await expect(
        pushKilterUserData({ db, userId: TEST_USER_ID, accessToken: 'test-token' }),
      ).resolves.toBeUndefined();
    });
  });
});
