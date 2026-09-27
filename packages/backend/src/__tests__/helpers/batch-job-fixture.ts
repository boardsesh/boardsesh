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
 * Setup truncates these tables before every test file; `clearBatchJobFixture`
 * removes what the jobs wrote so later files in the same worker start clean.
 */
import { randomUUID } from 'node:crypto';
import { eq, inArray, like, sql } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import type { JobDatabase } from '@boardsesh/db/jobs';

export const FIXTURE_PREFIX = 'batch-job-fixture-';
export const KILTER_CLIMBS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'].map(
  (name) => `${FIXTURE_PREFIX}${name}`,
);
export const MOONBOARD_CLIMB = `${FIXTURE_PREFIX}moon`;
const LAYOUT = 8;
const SIZE = 17;
const PLACEMENTS = [9001, 9002, 9003, 9004, 9005, 9006];

export async function seedBatchJobFixture(db: JobDatabase): Promise<void> {
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

/** Remove everything the fixture and the three jobs wrote. */
export async function clearBatchJobFixture(db: JobDatabase): Promise<void> {
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
  await db.delete(dbSchema.boardGradeCoefficients);
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
