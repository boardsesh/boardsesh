import { and, eq, exists, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { canAddClimbToBoard } from '@boardsesh/board-config';
import { getBoulderGradesForBoard } from '@boardsesh/board-constants/boulder-grade-mapping';
import { boardClimbs, boardClimbStats, boardDifficultyGrades } from '@boardsesh/db/schema';
import { climbReferenceReadableCondition, getMaterializedSimilarClimbs } from '@boardsesh/db/queries';
import type {
  BoardName,
  ConnectionContext,
  PublicClimbRelatedContentInput,
  SimilarClimb,
} from '@boardsesh/shared-schema';
import { dbRead } from '../../../db/client';
import { searchClimbs } from '../../../db/queries/climbs';
import { redisClientManager } from '../../../redis/client';
import { logger } from '../../../utils/logger';
import { BoardNameSchema, ExternalUUIDSchema } from '../../../validation/schemas/primitives';
import { applyRateLimit, validateInput } from '../shared/helpers';
import { getStoredPublicBetaLinks } from '../beta-videos/queries';
import {
  PublicClimbRelatedContentService,
  PUBLIC_RELATED_CACHE_MAX_BYTES,
  PUBLIC_RELATED_CACHE_MAX_ENTRIES,
  PUBLIC_RELATED_CACHE_PREFIX,
  publicRelatedCacheTtlSeconds,
  type PublicRelatedCandidate,
  type PublicRelatedSnapshot,
  type PublicRelatedTarget,
  type PublicRelatedDependencies,
} from '../../../services/public-climb-related-content';

export const PublicClimbRelatedContentInputSchema = z.object({
  boardType: BoardNameSchema,
  layoutId: z.number().int().positive(),
  sizeId: z.number().int().positive(),
  setIds: z
    .array(z.number().int().positive())
    .min(1)
    .max(30)
    .transform((setIds) => [...new Set(setIds)].sort((left, right) => left - right)),
  angle: z.number().int().min(-90).max(90),
  climbUuid: ExternalUUIDSchema,
  includeNearby: z.boolean().nullish(),
});

const candidateSchema = z.object({
  uuid: ExternalUUIDSchema,
  similarity: z.number().finite().min(0).max(1),
  sharedHoldCount: z.number().int().nonnegative(),
  candidateHoldCount: z.number().int().nonnegative(),
  targetHoldCount: z.number().int().nonnegative(),
});
const snapshotSchema = z.object({
  similar: z.array(candidateSchema).max(25),
  nearby: z.array(candidateSchema).max(14),
  nearbyGrade: z.string().max(30).nullable(),
});
const cacheTtlSeconds = publicRelatedCacheTtlSeconds(process.env.PUBLIC_CLIMB_RECOMMENDATION_CACHE_DAYS);
const CACHE_INDEX_KEY = `${PUBLIC_RELATED_CACHE_PREFIX}:index`;

// One atomic insertion/trim across backend replicas. Index cardinality stays bounded
// even when expired payload keys leave stale index members behind.
export const WRITE_PUBLIC_RELATED_CACHE_SCRIPT = `
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
redis.call('ZADD', KEYS[2], ARGV[3], KEYS[1])
local excess = redis.call('ZCARD', KEYS[2]) - tonumber(ARGV[4])
if excess > 0 then
  local victims = redis.call('ZRANGE', KEYS[2], 0, excess - 1)
  for _, victim in ipairs(victims) do
    redis.call('DEL', victim)
    redis.call('ZREM', KEYS[2], victim)
  end
end
redis.call('EXPIRE', KEYS[2], ARGV[2])
return 1
`;

function publicTargetCondition(input: PublicClimbRelatedContentInput) {
  return and(
    eq(boardClimbs.boardType, input.boardType),
    eq(boardClimbs.uuid, input.climbUuid),
    eq(boardClimbs.layoutId, input.layoutId),
    sql`${boardClimbs.isDraft} IS NOT TRUE`,
    sql`${boardClimbs.isListed} IS NOT FALSE`,
    sql`${boardClimbs.isHidden} IS NOT TRUE`,
    climbReferenceReadableCondition(
      { boardType: sql`${input.boardType}`, climbUuid: sql`${input.climbUuid}` },
      undefined,
    ),
  );
}

async function readTarget(input: PublicClimbRelatedContentInput): Promise<PublicRelatedTarget | null> {
  const [target] = await dbRead
    .select({ revision: boardClimbs.syncSeq, difficulty: boardClimbStats.displayDifficulty })
    .from(boardClimbs)
    .leftJoin(
      boardClimbStats,
      and(
        eq(boardClimbStats.boardType, boardClimbs.boardType),
        eq(boardClimbStats.climbUuid, boardClimbs.uuid),
        eq(boardClimbStats.angle, input.angle),
      ),
    )
    .where(publicTargetCondition(input))
    .limit(1);
  return target
    ? {
        revision: String(target.revision),
        difficulty: target.difficulty == null ? null : Math.round(Number(target.difficulty)),
      }
    : null;
}

function candidateIds(climbs: SimilarClimb[]): PublicRelatedCandidate[] {
  return climbs.map(({ uuid, similarity, sharedHoldCount, candidateHoldCount, targetHoldCount }) => ({
    uuid,
    similarity,
    sharedHoldCount,
    candidateHoldCount,
    targetHoldCount,
  }));
}

async function buildSnapshot(
  input: PublicClimbRelatedContentInput,
  target: PublicRelatedTarget,
): Promise<PublicRelatedSnapshot> {
  const similar = await getMaterializedSimilarClimbs(dbRead, {
    boardType: input.boardType,
    layoutId: input.layoutId,
    climbUuid: input.climbUuid,
    threshold: 0.5,
    limit: 25,
    sizeId: input.boardType === 'woods' ? input.sizeId : undefined,
    statsAngle: input.angle,
  });
  const snapshot: PublicRelatedSnapshot = { similar: candidateIds(similar), nearby: [], nearbyGrade: null };
  if (similar.length > 0 || input.includeNearby === false || target.difficulty == null) return snapshot;
  const grades = getBoulderGradesForBoard(input.boardType as BoardName);
  const targetGrade = grades.find((grade) => grade.difficulty_id === target.difficulty);
  if (!targetGrade) return snapshot;
  const targetVGrade = Number(targetGrade.v_grade.slice(1));
  const band = grades.filter((grade) => Math.abs(Number(grade.v_grade.slice(1)) - targetVGrade) <= 1);
  const minGrade = band[0]?.difficulty_id;
  const maxGrade = band.at(-1)?.difficulty_id;
  if (minGrade == null || maxGrade == null) return snapshot;
  snapshot.nearbyGrade = targetGrade.difficulty_name;
  const params = {
    board_name: input.boardType as BoardName,
    layout_id: input.layoutId,
    size_id: input.sizeId,
    set_ids: input.setIds,
    angle: input.angle,
  };
  try {
    for (const page of [0, 1]) {
      const { climbs } = await searchClimbs(params, {
        minGrade,
        maxGrade,
        minAscents: 1,
        sortBy: 'ascents',
        sortOrder: 'desc',
        page,
        pageSize: 7,
      });
      snapshot.nearby = climbs
        .filter(
          (climb) =>
            climb.uuid !== input.climbUuid && Boolean(climb.difficulty) && canAddClimbToBoard(climb, params).ok,
        )
        .slice(0, 6)
        .map((climb) => ({
          uuid: climb.uuid,
          similarity: 0,
          sharedHoldCount: 0,
          candidateHoldCount: 0,
          targetHoldCount: 0,
        }));
      if (snapshot.nearby.length > 0 || climbs.length < 7) break;
    }
  } catch {
    snapshot.nearbyUnavailable = true;
  }
  return snapshot;
}

async function hydrate(
  input: PublicClimbRelatedContentInput,
  candidates: PublicRelatedCandidate[],
  target: PublicRelatedTarget,
): Promise<SimilarClimb[]> {
  if (candidates.length === 0) return [];
  const source = alias(boardClimbs, 'public_related_source');
  const currentSource = dbRead
    .select({ uuid: source.uuid })
    .from(source)
    .where(
      and(
        eq(source.boardType, input.boardType),
        eq(source.uuid, input.climbUuid),
        eq(source.layoutId, input.layoutId),
        sql`${source.isDraft} IS NOT TRUE`,
        sql`${source.isListed} IS NOT FALSE`,
        sql`${source.isHidden} IS NOT TRUE`,
      ),
    )
    .limit(1);
  const rows = await dbRead
    .select({
      uuid: boardClimbs.uuid,
      name: boardClimbs.name,
      setterUsername: boardClimbs.setterUsername,
      angle: boardClimbs.angle,
      layoutId: boardClimbs.layoutId,
      frames: boardClimbs.frames,
      compatibleSizeIds: boardClimbs.compatibleSizeIds,
      requiredSetIds: boardClimbs.requiredSetIds,
      characteristics: boardClimbs.characteristics,
      difficultyName: boardDifficultyGrades.boulderName,
      displayDifficulty: boardClimbStats.displayDifficulty,
      qualityAverage: boardClimbStats.qualityAverage,
      ascensionistCount: boardClimbStats.ascensionistCount,
    })
    .from(boardClimbs)
    .leftJoin(
      boardClimbStats,
      and(
        eq(boardClimbStats.boardType, boardClimbs.boardType),
        eq(boardClimbStats.climbUuid, boardClimbs.uuid),
        eq(boardClimbStats.angle, input.angle),
      ),
    )
    .leftJoin(
      boardDifficultyGrades,
      and(
        eq(boardDifficultyGrades.boardType, boardClimbs.boardType),
        sql`${boardDifficultyGrades.difficulty} = ROUND(${boardClimbStats.displayDifficulty})`,
      ),
    )
    .where(
      and(
        eq(boardClimbs.boardType, input.boardType),
        eq(boardClimbs.layoutId, input.layoutId),
        inArray(boardClimbs.uuid, [...new Set(candidates.map((candidate) => candidate.uuid))]),
        sql`${boardClimbs.isDraft} IS NOT TRUE`,
        sql`${boardClimbs.isListed} IS NOT FALSE`,
        sql`${boardClimbs.isHidden} IS NOT TRUE`,
        exists(currentSource),
        climbReferenceReadableCondition(
          { boardType: sql`${input.boardType}`, climbUuid: sql`${input.climbUuid}` },
          undefined,
        ),
      ),
    );
  const candidateByUuid = new Map(candidates.map((candidate) => [candidate.uuid, candidate]));
  const grades = getBoulderGradesForBoard(input.boardType);
  const targetGrade = grades.find((grade) => grade.difficulty_id === target.difficulty);
  const params = {
    board_name: input.boardType as BoardName,
    layout_id: input.layoutId,
    size_id: input.sizeId,
    set_ids: input.setIds,
  };
  return rows
    .filter((row) => {
      const isNearby = candidateByUuid.get(row.uuid)?.similarity === 0;
      if (!isNearby) return input.boardType !== 'woods' || (row.compatibleSizeIds ?? []).includes(input.sizeId);
      const grade = grades.find((grade) => grade.difficulty_id === Math.round(Number(row.displayDifficulty)));
      return Boolean(
        targetGrade &&
        grade &&
        Number(row.ascensionistCount) >= 1 &&
        Math.abs(Number(grade.v_grade.slice(1)) - Number(targetGrade.v_grade.slice(1))) <= 1 &&
        (row.requiredSetIds ?? []).every((setId) => input.setIds.includes(setId)) &&
        canAddClimbToBoard(row, params).ok,
      );
    })
    .map(({ displayDifficulty: _displayDifficulty, ...row }) => ({
      ...row,
      angle: candidateByUuid.get(row.uuid)?.similarity === 0 ? input.angle : row.angle,
      compatibleSizeIds: row.compatibleSizeIds ?? [],
      qualityAverage: row.qualityAverage == null ? null : Number(row.qualityAverage),
      ascensionistCount: row.ascensionistCount == null ? null : Number(row.ascensionistCount),
      similarity: 0,
      sharedHoldCount: 0,
      candidateHoldCount: 0,
      targetHoldCount: 0,
    }));
}

let lastFailureReport = 0;
let lastStatsReport = 0;
export const publicClimbRelatedContentDependencies: PublicRelatedDependencies = {
  readTarget,
  buildSnapshot,
  hydrate,
  async readCache(key) {
    if (!redisClientManager.isRedisConnected()) throw new Error('Recommendation cache unavailable');
    const payload = await redisClientManager.getClients().publisher.get(key);
    if (!payload || Buffer.byteLength(payload) > PUBLIC_RELATED_CACHE_MAX_BYTES) return null;
    try {
      const parsed = snapshotSchema.safeParse(JSON.parse(payload));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  },
  async writeCache(key, snapshot) {
    const payload = JSON.stringify(snapshot);
    if (Buffer.byteLength(payload) > PUBLIC_RELATED_CACHE_MAX_BYTES) return;
    if (!redisClientManager.isRedisConnected()) return;
    await redisClientManager
      .getClients()
      .publisher.eval(
        WRITE_PUBLIC_RELATED_CACHE_SCRIPT,
        2,
        key,
        CACHE_INDEX_KEY,
        payload,
        String(cacheTtlSeconds),
        String(Date.now()),
        String(PUBLIC_RELATED_CACHE_MAX_ENTRIES),
      );
  },
  readBeta: (input) => getStoredPublicBetaLinks(input.boardType, input.climbUuid),
  reportFailure() {
    if (Date.now() - lastFailureReport < 60_000) return;
    lastFailureReport = Date.now();
    logger.warn('[PublicClimbRelatedContent] optional reads unavailable', publicClimbRelatedContentService.getStats());
  },
};

export const publicClimbRelatedContentService = new PublicClimbRelatedContentService(
  publicClimbRelatedContentDependencies,
);

export async function publicClimbRelatedContent(
  _: unknown,
  { input }: { input: PublicClimbRelatedContentInput },
  ctx: ConnectionContext,
) {
  await applyRateLimit(ctx, 600, 'public-climb-related-content');
  const response = await publicClimbRelatedContentService.read(
    validateInput(PublicClimbRelatedContentInputSchema, input, 'input'),
  );
  if (Date.now() - lastStatsReport >= 60_000) {
    lastStatsReport = Date.now();
    logger.info('[PublicClimbRelatedContent] reads', publicClimbRelatedContentService.getStats());
  }
  return response;
}
