/**
 * The smallest catalog the three batch jobs (refresh-recommendations,
 * refresh-hold-features, refresh-climb-grades) do real work on:
 *
 * - six listed Kilter Homewall climbs (layout 8) that fit size 17 at 40°,
 *   good enough for every public cohort playlist variant on that cohort, and
 *   sharing holds often enough (5+ climbs) for a hold to get a rating;
 * - six placements on layout 8 with holes, the climbs' holds, and the
 *   size-17 product-size row the shadow hold classifications key on;
 * - one MoonBoard climb with ascents, so the weekly history snapshot writes.
 *
 * `seedClimbNeighborFixture` adds six Tension climbs on two layouts of their
 * own for the neighbours job (refresh-climb-neighbors), so a run can be
 * stopped between the two groups.
 *
 * `seedWideAngleShapeFixture` adds, on demand, what the MoonBoard wide-angle
 * job needs to publish: a Tension angle surface and one stale wide estimate.
 * It is separate so the nightly jobs above never see those Tension stats.
 *
 * Setup truncates these tables before every test file; `clearBatchJobFixture`
 * removes what the jobs wrote so later files in the same worker start clean.
 */
import { randomUUID } from 'node:crypto';
import { eq, inArray, like, sql } from 'drizzle-orm';
import { MOONBOARD_WIDE_ANGLES } from '@boardsesh/board-config';
import * as dbSchema from '@boardsesh/db/schema';
import type { JobDatabase } from '@boardsesh/db/jobs';
import { rowsOf } from '@boardsesh/db/queries';

export const FIXTURE_PREFIX = 'batch-job-fixture-';
export const KILTER_CLIMBS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'].map(
  (name) => `${FIXTURE_PREFIX}${name}`,
);
export const MOONBOARD_CLIMB = `${FIXTURE_PREFIX}moon`;
/** The neighbours fixture's board and its two comparison groups, smallest first. */
export const NEIGHBOR_BOARD = 'tension';
export const NEIGHBOR_SMALL_LAYOUT = 9901;
export const NEIGHBOR_LARGE_LAYOUT = 9902;
export const NEIGHBOR_SMALL_CLIMBS = ['nb-a', 'nb-b'].map((name) => `${FIXTURE_PREFIX}${name}`);
export const NEIGHBOR_LARGE_CLIMBS = ['nb-c', 'nb-d', 'nb-e', 'nb-f'].map((name) => `${FIXTURE_PREFIX}${name}`);
/**
 * A second MoonBoard climb, graded at BOTH 25° and 40°, so the same-board
 * angle-estimate job (refresh-moonboard-angle-estimates) has a one-row dual-
 * angle training sample to fit a pooled delta from (buildCell only requires
 * n >= 1; ANGLE_CELL_MIN_CLIMBS gates band-level cells, not the pooled fit).
 */
export const MOONBOARD_DUAL_ANGLE_CLIMB = `${FIXTURE_PREFIX}moon-dual`;
/**
 * Thirty Tension climbs graded at every MoonBoard wide angle: the smallest set
 * that gives the wide-angle job a shape board (ANGLE_CELL_MIN_CLIMBS = 30 per
 * angle, each with ANGLE_FIT_MIN_ASCENTS = 10 ascents at two or more angles).
 */
export const TENSION_SHAPE_CLIMBS = Array.from(
  { length: 30 },
  (_, index) => `${FIXTURE_PREFIX}tension-${String(index).padStart(2, '0')}`,
);
/**
 * A listed MoonBoard climb with no grade at 25° or 40°, so the wide-angle job
 * does not target it. Its pre-seeded wide estimate is stale and must be reaped.
 */
export const MOONBOARD_STALE_WIDE_CLIMB = `${FIXTURE_PREFIX}moon-stale`;
export const MOONBOARD_STALE_WIDE_ANGLE = 50;
/** The angles a wide-angle ladder covers: every wide angle but the real 25° and 40°. */
export const MOONBOARD_WIDE_LADDER_ANGLES = MOONBOARD_WIDE_ANGLES.filter((angle) => angle !== 25 && angle !== 40);
const LAYOUT = 8;
const SIZE = 17;
const PLACEMENTS = [9001, 9002, 9003, 9004, 9005, 9006];

/**
 * The database clock when the fixture was seeded. Coefficient rows carry no
 * climb, so the ones the jobs wrote are told apart by when they were written.
 */
let seededAt: string | undefined;

export async function seedBatchJobFixture(db: JobDatabase): Promise<void> {
  const [clock] = rowsOf<{ seeded_at: string }>(
    await db.execute(sql`SELECT clock_timestamp()::timestamp::text AS seeded_at`),
  );
  seededAt = clock?.seeded_at;
  const publishedAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  await db.insert(dbSchema.boardClimbs).values([
    ...KILTER_CLIMBS.map((uuid, index) => ({
      uuid,
      boardType: 'kilter',
      layoutId: LAYOUT,
      setterUsername: index < 2 ? 'fixture-setter-a' : 'fixture-setter-b',
      name: uuid,
      frames: 'p9001r12',
      framesCount: 1,
      isDraft: false,
      isListed: true,
      edgeLeft: 0,
      edgeRight: 200,
      edgeBottom: 0,
      edgeTop: 200,
      requiredSetIds: [],
      compatibleSizeIds: [SIZE],
      publishedAt,
    })),
    {
      uuid: MOONBOARD_CLIMB,
      boardType: 'moonboard',
      layoutId: 1,
      setterUsername: 'fixture-moon-setter',
      name: MOONBOARD_CLIMB,
      frames: '',
      framesCount: 1,
      isDraft: false,
      isListed: true,
    },
    {
      uuid: MOONBOARD_DUAL_ANGLE_CLIMB,
      boardType: 'moonboard',
      layoutId: 1,
      setterUsername: 'fixture-moon-setter',
      name: MOONBOARD_DUAL_ANGLE_CLIMB,
      frames: '',
      framesCount: 1,
      isDraft: false,
      isListed: true,
    },
  ]);
  // Quality and ascents clear the crowd-favorites (4.0, 20+) and hidden-gems
  // (4.5, 5..50) bars; MIN_ASCENTS for hold features is 20.
  await db.insert(dbSchema.boardClimbStats).values(
    KILTER_CLIMBS.map((climbUuid, index) => ({
      boardType: 'kilter',
      climbUuid,
      angle: 40,
      ascensionistCount: 21 + 2 * index,
      qualityAverage: 4.6 + 0.05 * index,
      difficultyAverage: 16 + index,
      displayDifficulty: 16 + index,
    })),
  );
  await db.insert(dbSchema.boardClimbStats).values({
    boardType: 'moonboard',
    climbUuid: MOONBOARD_CLIMB,
    angle: 40,
    ascensionistCount: 5,
    qualityAverage: 3,
    difficultyAverage: 20,
    displayDifficulty: 20,
  });
  // Graded at both angles, 40° harder than 25° — the sign the same-board
  // angle-estimate job's pooled fit requires to be usable.
  await db.insert(dbSchema.boardClimbStats).values([
    {
      boardType: 'moonboard',
      climbUuid: MOONBOARD_DUAL_ANGLE_CLIMB,
      angle: 25,
      ascensionistCount: 5,
      qualityAverage: 3,
      difficultyAverage: 15,
      displayDifficulty: 15,
    },
    {
      boardType: 'moonboard',
      climbUuid: MOONBOARD_DUAL_ANGLE_CLIMB,
      angle: 40,
      ascensionistCount: 5,
      qualityAverage: 3,
      difficultyAverage: 18,
      displayDifficulty: 18,
    },
  ]);
  await db
    .insert(dbSchema.boardHoles)
    .values(
      PLACEMENTS.map((id, index) => ({ boardType: 'kilter', id, name: `H${index}`, x: 8 * (index % 3), y: 8 * index })),
    );
  await db
    .insert(dbSchema.boardPlacements)
    .values(PLACEMENTS.map((id) => ({ boardType: 'kilter', id, layoutId: LAYOUT, holeId: id, setId: 1 })));
  await db
    .insert(dbSchema.boardProductSizesLayoutsSets)
    .values({ boardType: 'kilter', id: 9001, productSizeId: SIZE, layoutId: LAYOUT, setId: 1 });
  // Every climb starts on 9001, finishes on 9003 and stands on 9004; the middle
  // hand and the second foot alternate, so each role has its 5+ samples.
  const holds: Array<[string, number, string]> = KILTER_CLIMBS.flatMap(
    (climb, index): Array<[string, number, string]> => [
      [climb, 9001, 'STARTING'],
      [climb, index % 2 === 0 ? 9002 : 9005, 'HAND'],
      [climb, 9003, 'FINISH'],
      [climb, 9004, 'FOOT'],
      [climb, 9006, 'FOOT'],
    ],
  );
  await db.insert(dbSchema.boardClimbHolds).values(
    holds.map(([climbUuid, holdId, holdState]) => ({
      boardType: 'kilter',
      climbUuid,
      holdId,
      frameNumber: 0,
      holdState,
    })),
  );
}

/** Tension frames lighting each hold as a hand (role 6). */
export function tensionFrames(holdIds: readonly number[]): string {
  return holdIds.map((holdId) => `p${holdId}r6`).join('');
}

function holdRange(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, offset) => from + offset);
}

/** Insert one listed, single-frame Tension climb for the neighbours job. */
export async function insertNeighborClimb(
  db: JobDatabase,
  { uuid, layoutId, holds }: { uuid: string; layoutId: number; holds: readonly number[] },
): Promise<void> {
  await db.insert(dbSchema.boardClimbs).values({
    uuid,
    boardType: NEIGHBOR_BOARD,
    layoutId,
    setterUsername: 'fixture-neighbor-setter',
    name: uuid,
    frames: tensionFrames(holds),
    framesCount: 1,
    isDraft: false,
    isListed: true,
  });
}

/**
 * Layout 9901: two climbs sharing 9 of 11 holds. Layout 9902: four climbs that
 * share 10 of 12 holds pairwise, so each list there has three neighbours. The
 * climbs are aged past the watermark's one-hour settle window (moving only
 * `updated_at`, which the sync trigger ignores), so a build lands its
 * watermark on them.
 */
export async function seedClimbNeighborFixture(db: JobDatabase): Promise<void> {
  await insertNeighborClimb(db, {
    uuid: NEIGHBOR_SMALL_CLIMBS[0],
    layoutId: NEIGHBOR_SMALL_LAYOUT,
    holds: holdRange(1, 10),
  });
  await insertNeighborClimb(db, {
    uuid: NEIGHBOR_SMALL_CLIMBS[1],
    layoutId: NEIGHBOR_SMALL_LAYOUT,
    holds: [...holdRange(1, 9), 11],
  });
  for (const [variant, uuid] of NEIGHBOR_LARGE_CLIMBS.entries()) {
    await insertNeighborClimb(db, {
      uuid,
      layoutId: NEIGHBOR_LARGE_LAYOUT,
      holds: [...holdRange(1, 10), 20 + variant],
    });
  }
  await db
    .update(dbSchema.boardClimbs)
    .set({ updatedAt: sql`now() - interval '2 hours'` })
    .where(like(dbSchema.boardClimbs.uuid, `${FIXTURE_PREFIX}nb-%`));
}

/** The neighbours job's state for the fixture board: lists, watermark and finished groups. */
export async function clearClimbNeighborState(db: JobDatabase): Promise<void> {
  await db.delete(dbSchema.boardClimbNeighbors).where(eq(dbSchema.boardClimbNeighbors.boardType, NEIGHBOR_BOARD));
  await db.delete(dbSchema.boardClimbNeighborRuns).where(eq(dbSchema.boardClimbNeighborRuns.boardType, NEIGHBOR_BOARD));
  await db
    .delete(dbSchema.boardClimbNeighborGroupRuns)
    .where(eq(dbSchema.boardClimbNeighborGroupRuns.boardType, NEIGHBOR_BOARD));
}

/**
 * The Tension angle surface and the stale wide estimate (see
 * TENSION_SHAPE_CLIMBS). Grades rise 0.5 per 5°, so the fitted offsets are
 * monotonic and every wide angle is covered for every band through the
 * surface's band-agnostic `all` row.
 */
export async function seedWideAngleShapeFixture(db: JobDatabase): Promise<void> {
  await db.insert(dbSchema.boardClimbs).values([
    ...TENSION_SHAPE_CLIMBS.map((uuid) => ({
      uuid,
      boardType: 'tension',
      layoutId: 10,
      setterUsername: 'fixture-tension-setter',
      name: uuid,
      frames: '',
      framesCount: 1,
      isDraft: false,
      isListed: true,
    })),
    {
      uuid: MOONBOARD_STALE_WIDE_CLIMB,
      boardType: 'moonboard',
      layoutId: 1,
      setterUsername: 'fixture-moon-setter',
      name: MOONBOARD_STALE_WIDE_CLIMB,
      frames: '',
      framesCount: 1,
      isDraft: false,
      isListed: true,
    },
  ]);
  await db.insert(dbSchema.boardClimbStats).values(
    TENSION_SHAPE_CLIMBS.flatMap((climbUuid, index) =>
      MOONBOARD_WIDE_ANGLES.map((angle) => {
        const difficulty = 17 + (index % 3) + (angle - 40) / 10;
        return {
          boardType: 'tension',
          climbUuid,
          angle,
          ascensionistCount: 12,
          qualityAverage: 3,
          difficultyAverage: difficulty,
          displayDifficulty: difficulty,
        };
      }),
    ),
  );
  await db.insert(dbSchema.boardClimbGrades).values({
    boardType: 'moonboard',
    climbUuid: MOONBOARD_STALE_WIDE_CLIMB,
    angle: MOONBOARD_STALE_WIDE_ANGLE,
    localGrade: 20,
    gradeLow: 19,
    gradeHigh: 21,
    confidence: 'moonboard_wide_angle_estimate',
    ascensionistCount: 0,
    modelVersion: 'moonboard-wide-angle-v1',
    coeffVersion: 'fixture-last-week',
  });
}

/** Remove everything the fixture and the batch jobs wrote. */
export async function clearBatchJobFixture(db: JobDatabase): Promise<void> {
  await clearClimbNeighborState(db);
  const generated = db
    .select({ id: dbSchema.playlists.id })
    .from(dbSchema.playlists)
    .where(sql`${dbSchema.playlists.generatedRecommendation} IS NOT NULL`);
  await db.delete(dbSchema.playlistClimbs).where(inArray(dbSchema.playlistClimbs.playlistId, generated));
  await db.delete(dbSchema.playlistOwnership).where(inArray(dbSchema.playlistOwnership.playlistId, generated));
  await db.delete(dbSchema.playlists).where(sql`${dbSchema.playlists.generatedRecommendation} IS NOT NULL`);
  await db.delete(dbSchema.syncDeletions).where(eq(dbSchema.syncDeletions.userId, 'system-recommendations'));
  await db.delete(dbSchema.boardSetterStats).where(like(dbSchema.boardSetterStats.setterUsername, 'fixture-%'));
  await db
    .delete(dbSchema.boardClimbSendStats)
    .where(like(dbSchema.boardClimbSendStats.climbUuid, `${FIXTURE_PREFIX}%`));
  await db.delete(dbSchema.boardHoldFeatures).where(inArray(dbSchema.boardHoldFeatures.placementId, PLACEMENTS));
  await db
    .delete(dbSchema.userHoldClassifications)
    .where(eq(dbSchema.userHoldClassifications.userId, 'system-hold-classifier'));
  await db.delete(dbSchema.boardClimbGrades).where(like(dbSchema.boardClimbGrades.climbUuid, `${FIXTURE_PREFIX}%`));
  if (seededAt) {
    await db
      .delete(dbSchema.boardGradeCoefficients)
      .where(sql`${dbSchema.boardGradeCoefficients.createdAt} >= ${seededAt}::timestamp`);
  }
  await db
    .delete(dbSchema.boardClimbStatsHistory)
    .where(like(dbSchema.boardClimbStatsHistory.climbUuid, `${FIXTURE_PREFIX}%`));
  await db.delete(dbSchema.boardSharedSyncs).where(like(dbSchema.boardSharedSyncs.tableName, '__local_%'));
  await db.delete(dbSchema.boardClimbHolds).where(like(dbSchema.boardClimbHolds.climbUuid, `${FIXTURE_PREFIX}%`));
  await db.delete(dbSchema.boardClimbStats).where(like(dbSchema.boardClimbStats.climbUuid, `${FIXTURE_PREFIX}%`));
  await db.delete(dbSchema.boardClimbs).where(like(dbSchema.boardClimbs.uuid, `${FIXTURE_PREFIX}%`));
  await db.delete(dbSchema.boardPlacements).where(inArray(dbSchema.boardPlacements.id, PLACEMENTS));
  await db.delete(dbSchema.boardHoles).where(inArray(dbSchema.boardHoles.id, PLACEMENTS));
  await db.delete(dbSchema.boardProductSizesLayoutsSets).where(eq(dbSchema.boardProductSizesLayoutsSets.id, 9001));
}

/** A fixture climb's PostHog result row: [climb_uuid, sends_30d, senders_30d, sends_90d, last_sent_at]. */
export function posthogSendRows(): unknown[][] {
  return [
    [KILTER_CLIMBS[0], 3, 2, 5, '2026-09-20T10:00:00Z'],
    [`unknown-${randomUUID()}`, 1, 1, 1, null],
  ];
}
