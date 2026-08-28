// Real-Postgres test for the kilter-sync climb-ratings upsert (issue #3524).
//
// Both behaviours under test are properties of the generated SQL, not of JS,
// so a mocked-drizzle unit test could only re-assert a predicate we wrote
// ourselves. These run the real `insert ... on conflict do update` against
// Postgres and read the stored timestamps back:
//
//   1. created_at must come from the upstream rating date, not defaultNow().
//   2. updated_at must only move when the rating actually changed — PowerSync
//      redelivers a full snapshot every cycle, so an unguarded DO UPDATE
//      rewrites updated_at on every sync for every row.
import { describe, it, expect, beforeEach } from 'vite-plus/test';
import { and, eq, sql } from 'drizzle-orm';
import { boardClimbRatings } from '@boardsesh/db/schema';
import { applyClimbRatings } from '@boardsesh/kilter-sync/sync';
import type { PowerSyncOp } from '@boardsesh/kilter-sync/api';
import { db } from '../db/client';

// Seeded by the shared test setup.
const USER_ID = 'user-123';
const CLIMB_UUID = 'climb-rating-ts-1';
const ANGLE = 40;
// Deliberately carries a non-UTC offset: Kilter sends ISO strings with an
// offset and the stored value must be the normalised UTC instant.
const UPSTREAM_RATED_AT = '2024-03-05T18:30:00+02:00';
const UPSTREAM_RATED_AT_UTC_MS = Date.parse(UPSTREAM_RATED_AT);

type RatingPayload = {
  rating: number | null;
  difficulty_grade_id: number | null;
  comment: string | null;
  created_at: string;
};

function putOp({ rating, difficulty_grade_id, comment, created_at }: RatingPayload): PowerSyncOp {
  return {
    op: 'PUT',
    object_id: 'kilter-rating-1',
    object_type: 'climb_ratings',
    data: {
      id: 'kilter-rating-1',
      climb_rating_uuid: 'kilter-rating-1',
      user_uuid: 'kilter-user-1',
      gym_uuid: null,
      wall_uuid: null,
      product_layout_uuid: null,
      climb_uuid: CLIMB_UUID,
      angle: ANGLE,
      rating,
      difficulty_grade_id,
      comment,
      created_at,
    },
  } as unknown as PowerSyncOp;
}

async function syncRating(payload: RatingPayload): Promise<void> {
  await applyClimbRatings(db, USER_ID, [putOp(payload)], new Map<string, string>(), () => {});
}

async function readRating() {
  const [row] = await db
    .select({
      rating: boardClimbRatings.rating,
      difficultyGradeId: boardClimbRatings.difficultyGradeId,
      comment: boardClimbRatings.comment,
      kilterId: boardClimbRatings.kilterId,
      createdAt: boardClimbRatings.createdAt,
      updatedAt: boardClimbRatings.updatedAt,
    })
    .from(boardClimbRatings)
    .where(and(eq(boardClimbRatings.userId, USER_ID), eq(boardClimbRatings.climbUuid, CLIMB_UUID)))
    .limit(1);
  return row ?? null;
}

// Backdate updated_at so a rewrite is unmistakable: the column defaults to
// now(), and a same-millisecond comparison could otherwise pass by accident.
const BACKDATED_UPDATED_AT = new Date('2020-01-01T00:00:00Z');

async function backdateUpdatedAt(): Promise<void> {
  await db
    .update(boardClimbRatings)
    .set({ updatedAt: BACKDATED_UPDATED_AT })
    .where(and(eq(boardClimbRatings.userId, USER_ID), eq(boardClimbRatings.climbUuid, CLIMB_UUID)));
}

describe('applyClimbRatings timestamps (real Postgres)', () => {
  beforeEach(async () => {
    await db.delete(boardClimbRatings).where(eq(boardClimbRatings.userId, USER_ID));
  });

  it('stamps created_at from the upstream rating date, not sync time', async () => {
    await syncRating({ rating: 4, difficulty_grade_id: 17, comment: 'crimpy', created_at: UPSTREAM_RATED_AT });

    const row = await readRating();
    expect(row).not.toBeNull();
    expect(row?.createdAt?.getTime()).toBe(UPSTREAM_RATED_AT_UTC_MS);
  });

  it('falls back to the column default when upstream sends an unparseable date', async () => {
    const before = Date.now() - 1000;
    await syncRating({ rating: 3, difficulty_grade_id: 17, comment: '', created_at: 'not-a-date' });

    const row = await readRating();
    // No Invalid Date written (which Postgres rejects and would abort the
    // whole ratings batch) — the row exists with a now()-ish created_at.
    expect(row).not.toBeNull();
    expect(row?.createdAt?.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('leaves updated_at alone when an unchanged rating is redelivered', async () => {
    const payload: RatingPayload = {
      rating: 4,
      difficulty_grade_id: 17,
      comment: 'crimpy',
      created_at: UPSTREAM_RATED_AT,
    };
    await syncRating(payload);
    await backdateUpdatedAt();

    // Exactly what the next PowerSync cycle redelivers: same row, no change.
    await syncRating(payload);

    const row = await readRating();
    expect(row?.updatedAt?.getTime()).toBe(BACKDATED_UPDATED_AT.getTime());
    // The conflict path must never re-stamp created_at either.
    expect(row?.createdAt?.getTime()).toBe(UPSTREAM_RATED_AT_UTC_MS);
  });

  it('treats a cleared upstream comment as a real change', async () => {
    await syncRating({ rating: 4, difficulty_grade_id: 17, comment: 'crimpy', created_at: UPSTREAM_RATED_AT });
    await backdateUpdatedAt();

    // A null upstream comment is normalised to '' before the insert, so the
    // SET's COALESCE(EXCLUDED.comment, …) never fires for kilter PUTs and the
    // stored comment really is cleared. Pinning it here so the change guard
    // can't be mistaken for the reason a cleared comment stops propagating:
    // the write still lands and updated_at still moves.
    await syncRating({ rating: 4, difficulty_grade_id: 17, comment: null, created_at: UPSTREAM_RATED_AT });

    const row = await readRating();
    expect(row?.comment).toBe('');
    expect(row?.updatedAt?.getTime()).toBeGreaterThan(BACKDATED_UPDATED_AT.getTime());
  });

  it('bumps updated_at when the rating really changes', async () => {
    await syncRating({ rating: 4, difficulty_grade_id: 17, comment: 'crimpy', created_at: UPSTREAM_RATED_AT });
    await backdateUpdatedAt();

    await syncRating({ rating: 2, difficulty_grade_id: 17, comment: 'crimpy', created_at: UPSTREAM_RATED_AT });

    const row = await readRating();
    expect(row?.rating).toBe(2);
    expect(row?.updatedAt?.getTime()).toBeGreaterThan(BACKDATED_UPDATED_AT.getTime());
    // A changed rating still must not rewrite the original rating date.
    expect(row?.createdAt?.getTime()).toBe(UPSTREAM_RATED_AT_UTC_MS);
  });

  it('adopts kilter_id onto a Boardsesh-originated row and bumps updated_at once', async () => {
    await db.insert(boardClimbRatings).values({
      boardType: 'kilter',
      climbUuid: CLIMB_UUID,
      angle: ANGLE,
      userId: USER_ID,
      rating: 4,
      difficultyGradeId: 17,
      comment: 'crimpy',
      createdAt: new Date('2023-01-01T00:00:00Z'),
      updatedAt: BACKDATED_UPDATED_AT,
    });
    // Postgres stores the backdate; re-assert via a direct write so the row is
    // definitely not now()-stamped by the insert defaults.
    await backdateUpdatedAt();

    await syncRating({ rating: 4, difficulty_grade_id: 17, comment: 'crimpy', created_at: UPSTREAM_RATED_AT });

    const adopted = await readRating();
    expect(adopted?.kilterId).toBe('kilter-rating-1');
    // Adopting the surrogate IS a change, so updated_at moves...
    expect(adopted?.updatedAt?.getTime()).toBeGreaterThan(BACKDATED_UPDATED_AT.getTime());
    // ...but the Boardsesh-side created_at is preserved, not overwritten by
    // the upstream date.
    expect(adopted?.createdAt?.getTime()).toBe(Date.parse('2023-01-01T00:00:00Z'));

    // A second identical cycle now has nothing left to adopt: no bump.
    await backdateUpdatedAt();
    await syncRating({ rating: 4, difficulty_grade_id: 17, comment: 'crimpy', created_at: UPSTREAM_RATED_AT });
    const settled = await readRating();
    expect(settled?.updatedAt?.getTime()).toBe(BACKDATED_UPDATED_AT.getTime());
  });

  it('still applies the change guard across a full batch of rows', async () => {
    // Guards against a regression where the guard only worked for single-row
    // inserts: the real sync flushes hundreds of ratings per statement.
    const ops: PowerSyncOp[] = [0, 1, 2].map(
      (index) =>
        ({
          op: 'PUT',
          object_id: `kilter-rating-batch-${index}`,
          object_type: 'climb_ratings',
          data: {
            id: `kilter-rating-batch-${index}`,
            climb_rating_uuid: `kilter-rating-batch-${index}`,
            user_uuid: 'kilter-user-1',
            gym_uuid: null,
            wall_uuid: null,
            product_layout_uuid: null,
            climb_uuid: `${CLIMB_UUID}-batch-${index}`,
            angle: ANGLE,
            rating: 3,
            difficulty_grade_id: 17,
            comment: 'batch',
            created_at: UPSTREAM_RATED_AT,
          },
        }) as unknown as PowerSyncOp,
    );

    await applyClimbRatings(db, USER_ID, ops, new Map<string, string>(), () => {});
    await db
      .update(boardClimbRatings)
      .set({ updatedAt: BACKDATED_UPDATED_AT })
      .where(eq(boardClimbRatings.userId, USER_ID));

    await applyClimbRatings(db, USER_ID, ops, new Map<string, string>(), () => {});

    const rows = await db
      .select({ updatedAt: boardClimbRatings.updatedAt, createdAt: boardClimbRatings.createdAt })
      .from(boardClimbRatings)
      .where(and(eq(boardClimbRatings.userId, USER_ID), sql`${boardClimbRatings.climbUuid} LIKE '%-batch-%'`));

    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.updatedAt?.getTime()).toBe(BACKDATED_UPDATED_AT.getTime());
      expect(row.createdAt?.getTime()).toBe(UPSTREAM_RATED_AT_UTC_MS);
    }
  });
});
