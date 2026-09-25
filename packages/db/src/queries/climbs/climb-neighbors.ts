import { sql, type SQLWrapper } from 'drizzle-orm';
import { boardClimbNeighbors, boardClimbs, boardClimbStats, boardDifficultyGrades } from '../../schema/index';
import { rowsOf } from '../util/rows';

/**
 * Materialised similar climbs (`board_climb_neighbors`): the pure scoring core
 * the nightly job runs, and the read path the `similarClimbs` resolver serves
 * non-admin callers from. Design and runbook: docs/similar-climbs.md.
 */

/** Neighbours kept per climb. The play drawer asks for 12, the web strip for 10. */
export const CLIMB_NEIGHBOR_K = 25;

/**
 * Lowest Jaccard the job stores. Every caller today asks for the resolver's
 * default of 0.5, and the floor is what lets the job skip most of the hold
 * index (see `ClimbNeighborIndex.neighborsOf`). A request below it is answered
 * from what is stored, i.e. as if it had asked for 0.5.
 */
export const CLIMB_NEIGHBOR_MIN_JACCARD = 0.5;

/**
 * One climb as the index sees it: its hold ids, ascending and DISTINCT
 * (`distinctHoldIds` produces exactly that). The index counts one overlap per
 * posting it walks, so a repeated id would be counted twice and inflate the
 * climb's size and every score it takes part in.
 */
export type NeighborClimb = {
  uuid: string;
  holdIds: readonly number[];
};

export type ComputedNeighbor = {
  neighborUuid: string;
  sharedHoldCount: number;
  targetHoldCount: number;
  candidateHoldCount: number;
  jaccard: number;
};

// Guards `Math.ceil(threshold * size)` against float noise: 0.7 * 10 is
// 7.000000000000001, which would otherwise demand 8 shared holds.
const FLOAT_SLACK = 1e-9;

/**
 * In-memory hold → climbs inverted index over one comparison group (a layout,
 * or a layout + wall on Woods), answering "which climbs in this group share at
 * least `minJaccard` of their holds with this one".
 *
 * The score is the one `findSimilarClimbs` computes in SQL: position-only
 * Jaccard over distinct hold ids, shared / (|a| + |b| − shared).
 *
 * Sized for Kilter's layout 1: about 295k eligible climbs in one group, each
 * probed once in a full build. Everything on the hot path is a typed array.
 */
export class ClimbNeighborIndex {
  private readonly uuidsByPosition: string[];
  private readonly holdIdsByPosition: (readonly number[])[];
  private readonly sizes: Uint16Array;
  private readonly positionByUuid = new Map<string, number>();
  private readonly climbsByHold = new Map<number, Int32Array>();
  // Per-query scratch, reset by bumping the generation instead of clearing:
  // `seenGeneration[p] === generation` means p was met this query, and
  // `sharedCounts[p]` is then its running overlap with the target.
  private readonly seenGeneration: Int32Array;
  private readonly sharedCounts: Uint16Array;
  private readonly admitted: Int32Array;
  private generation = 0;

  constructor(climbs: readonly NeighborClimb[]) {
    const indexed = climbs.filter((climb) => climb.holdIds.length > 0);
    this.uuidsByPosition = indexed.map(({ uuid }) => uuid);
    this.holdIdsByPosition = indexed.map(({ holdIds }) => holdIds);
    this.sizes = Uint16Array.from(indexed, ({ holdIds }) => holdIds.length);
    const postings = new Map<number, number[]>();
    indexed.forEach((climb, position) => {
      this.positionByUuid.set(climb.uuid, position);
      for (const holdId of climb.holdIds) {
        const posting = postings.get(holdId);
        if (posting) posting.push(position);
        else postings.set(holdId, [position]);
      }
    });
    for (const [holdId, posting] of postings) this.climbsByHold.set(holdId, Int32Array.from(posting));
    this.seenGeneration = new Int32Array(indexed.length);
    this.sharedCounts = new Uint16Array(indexed.length);
    this.admitted = new Int32Array(indexed.length);
  }

  get size(): number {
    return this.uuidsByPosition.length;
  }

  has(uuid: string): boolean {
    return this.positionByUuid.has(uuid);
  }

  uuids(): string[] {
    return [...this.uuidsByPosition];
  }

  /**
   * Every other climb in the group at or above `minJaccard`, best first (ties by
   * uuid so reruns write identical lists). Empty when `uuid` is not indexed.
   *
   * One pass over the target's holds, rarest first, counting overlaps instead
   * of intersecting hold lists per candidate:
   *
   * - Prefix filter: a candidate reaching `minJaccard` shares at least
   *   ceil(minJaccard × |a|) of a's holds, so it must share one of ANY
   *   |a| − ceil(minJaccard × |a|) + 1 of them. Only the first that many holds
   *   (the rarest, with the shortest posting lists) may ADMIT a candidate.
   * - The remaining holds only add to the counts of admitted candidates, so
   *   when the pass ends each count is the exact overlap. Size filter
   *   (t·|a| ≤ |b| ≤ |a|/t) rejects at admission.
   */
  neighborsOf(uuid: string, minJaccard: number = CLIMB_NEIGHBOR_MIN_JACCARD): ComputedNeighbor[] {
    const position = this.positionByUuid.get(uuid);
    if (position === undefined) return [];
    const targetHolds = this.holdIdsByPosition[position];
    const targetSize = targetHolds.length;
    const threshold = Math.max(0, Math.min(1, minJaccard));
    const minShared = Math.max(1, Math.ceil(threshold * targetSize - FLOAT_SLACK));
    const prefixLength = targetSize - minShared + 1;
    const minCandidateSize = threshold * targetSize - FLOAT_SLACK;
    const maxCandidateSize = threshold > 0 ? targetSize / threshold + FLOAT_SLACK : Number.POSITIVE_INFINITY;
    const postingsRarestFirst = targetHolds
      .map((holdId) => this.climbsByHold.get(holdId) ?? new Int32Array(0))
      .sort((left, right) => left.length - right.length);

    this.generation += 1;
    const generation = this.generation;
    const { seenGeneration, sharedCounts, admitted, sizes } = this;
    // The target itself: seen, never admitted.
    seenGeneration[position] = generation;
    sharedCounts[position] = 0;
    let admittedCount = 0;

    for (let holdIndex = 0; holdIndex < postingsRarestFirst.length; holdIndex += 1) {
      const posting = postingsRarestFirst[holdIndex];
      const mayAdmit = holdIndex < prefixLength;
      for (let entry = 0; entry < posting.length; entry += 1) {
        const candidate = posting[entry];
        if (seenGeneration[candidate] === generation) {
          sharedCounts[candidate] += 1;
        } else if (mayAdmit) {
          seenGeneration[candidate] = generation;
          sharedCounts[candidate] = 1;
          const candidateSize = sizes[candidate];
          // Rejected by size: stays "seen" so it is never re-admitted, but is
          // not in `admitted`, so its count is never read.
          if (candidateSize >= minCandidateSize && candidateSize <= maxCandidateSize) {
            admitted[admittedCount] = candidate;
            admittedCount += 1;
          }
        }
      }
    }

    const neighbors: ComputedNeighbor[] = [];
    for (let slot = 0; slot < admittedCount; slot += 1) {
      const candidate = admitted[slot];
      const shared = sharedCounts[candidate];
      if (shared < minShared) continue;
      const candidateSize = sizes[candidate];
      const jaccard = shared / (targetSize + candidateSize - shared);
      if (jaccard + FLOAT_SLACK < threshold) continue;
      neighbors.push({
        neighborUuid: this.uuidsByPosition[candidate],
        sharedHoldCount: shared,
        targetHoldCount: targetSize,
        candidateHoldCount: candidateSize,
        jaccard,
      });
    }
    neighbors.sort(
      (left, right) =>
        right.jaccard - left.jaccard ||
        (left.neighborUuid < right.neighborUuid ? -1 : left.neighborUuid > right.neighborUuid ? 1 : 0),
    );
    return neighbors;
  }
}

/** The `SimilarClimb` shape `findSimilarClimbs` returns, field for field. */
export type MaterializedSimilarClimb = {
  uuid: string;
  name: string | null;
  setterUsername: string | null;
  angle: number | null;
  layoutId: number;
  frames: string | null;
  difficultyName: string | null;
  qualityAverage: number | null;
  ascensionistCount: number | null;
  compatibleSizeIds: number[];
  characteristics: string[] | null;
  similarity: number;
  sharedHoldCount: number;
  candidateHoldCount: number;
  targetHoldCount: number;
};

export type MaterializedSimilarClimbsArgs = {
  boardType: string;
  layoutId: number;
  climbUuid: string;
  threshold: number;
  limit: number;
  /** Woods only: keep neighbours that fit this wall, as `sizeScopeSql` does. */
  sizeId?: number;
  /** Viewer angle for the stats join; falls back to each neighbour's own angle. */
  statsAngle?: number;
};

type ExecuteConnection = { execute(query: SQLWrapper | string): PromiseLike<unknown> };

type MaterializedRow = {
  uuid: string;
  name: string | null;
  setter_username: string | null;
  angle: number | null;
  layout_id: number;
  frames: string | null;
  compatible_size_ids: number[] | null;
  characteristics: string[] | null;
  difficulty_name: string | null;
  quality_average: number | string | null;
  ascensionist_count: number | string | null;
  shared_hold_count: number;
  candidate_hold_count: number;
  target_hold_count: number;
  similarity: number | string;
};

/**
 * Read one climb's precomputed neighbours, re-checking each against the live
 * catalogue: a neighbour hidden, unlisted or turned back into a draft since the
 * nightly run drops out here rather than waiting for the next run.
 *
 * Similarity is recomputed from the stored integer counts in double precision
 * rather than read from the `real` column, so a pair at exactly the requested
 * threshold (7 of 10 holds at 0.7) is not lost to float4 rounding.
 */
export async function getMaterializedSimilarClimbs(
  executor: ExecuteConnection,
  { boardType, layoutId, climbUuid, threshold, limit, sizeId, statsAngle }: MaterializedSimilarClimbsArgs,
): Promise<MaterializedSimilarClimb[]> {
  const safeThreshold = Math.max(0, Math.min(1, threshold));
  const safeLimit = Math.max(1, Math.min(200, limit));
  const similarity = sql`(${boardClimbNeighbors.sharedHoldCount}::float8 / (${boardClimbNeighbors.targetHoldCount} + ${boardClimbNeighbors.candidateHoldCount} - ${boardClimbNeighbors.sharedHoldCount}))`;

  const result = await executor.execute(sql`
    SELECT
      ${boardClimbs.uuid} AS uuid,
      ${boardClimbs.name} AS name,
      ${boardClimbs.setterUsername} AS setter_username,
      ${boardClimbs.angle} AS angle,
      ${boardClimbs.layoutId} AS layout_id,
      ${boardClimbs.frames} AS frames,
      ${boardClimbs.compatibleSizeIds} AS compatible_size_ids,
      ${boardClimbs.characteristics} AS characteristics,
      ${boardDifficultyGrades.boulderName} AS difficulty_name,
      ${boardClimbStats.qualityAverage} AS quality_average,
      ${boardClimbStats.ascensionistCount} AS ascensionist_count,
      ${boardClimbNeighbors.sharedHoldCount} AS shared_hold_count,
      ${boardClimbNeighbors.candidateHoldCount} AS candidate_hold_count,
      ${boardClimbNeighbors.targetHoldCount} AS target_hold_count,
      ${similarity} AS similarity
    FROM ${boardClimbNeighbors}
    INNER JOIN ${boardClimbs}
      ON ${boardClimbs.uuid} = ${boardClimbNeighbors.neighborUuid}
     AND ${boardClimbs.boardType} = ${boardClimbNeighbors.boardType}
    LEFT JOIN ${boardClimbStats}
      ON ${boardClimbStats.boardType} = ${boardClimbs.boardType}
     AND ${boardClimbStats.climbUuid} = ${boardClimbs.uuid}
     AND ${boardClimbStats.angle} = ${statsAngle != null ? sql`${statsAngle}` : boardClimbs.angle}
    LEFT JOIN ${boardDifficultyGrades}
      ON ${boardDifficultyGrades.boardType} = ${boardClimbs.boardType}
     AND ${boardDifficultyGrades.difficulty} = ROUND(${boardClimbStats.displayDifficulty})
    WHERE ${boardClimbNeighbors.boardType} = ${boardType}
      AND ${boardClimbNeighbors.climbUuid} = ${climbUuid}
      AND ${boardClimbs.layoutId} = ${layoutId}
      AND ${boardClimbs.isDraft} = FALSE
      AND ${boardClimbs.isListed} IS NOT FALSE
      AND ${boardClimbs.isHidden} = FALSE
      ${sizeId !== undefined ? sql`AND COALESCE(${boardClimbs.compatibleSizeIds}, '{}'::int[]) @> ARRAY[${sizeId}]::int[]` : sql``}
      AND ${similarity} >= ${safeThreshold}
    ORDER BY similarity DESC, COALESCE(${boardClimbStats.ascensionistCount}, 0) DESC, ${boardClimbs.uuid} ASC
    LIMIT ${safeLimit}
  `);

  return rowsOf<MaterializedRow>(result).map((row) => ({
    uuid: row.uuid,
    name: row.name,
    setterUsername: row.setter_username,
    angle: row.angle,
    layoutId: row.layout_id,
    frames: row.frames,
    difficultyName: row.difficulty_name ?? null,
    qualityAverage: row.quality_average == null ? null : Number(row.quality_average),
    ascensionistCount: row.ascensionist_count == null ? null : Number(row.ascensionist_count),
    compatibleSizeIds: row.compatible_size_ids ?? [],
    // `?? null`, not `?? []`: null is a climb whose rules were never recorded,
    // which the Woods drawer prints differently from "default rules" (#5214).
    characteristics: row.characteristics ?? null,
    similarity: Number(row.similarity),
    sharedHoldCount: Number(row.shared_hold_count),
    candidateHoldCount: Number(row.candidate_hold_count),
    targetHoldCount: Number(row.target_hold_count),
  }));
}
