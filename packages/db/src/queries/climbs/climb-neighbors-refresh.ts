import { and, eq, gt, inArray, isNull, lt, lte, max, or, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type { BoardName } from '@boardsesh/shared-schema';
import { boardClimbNeighborRuns, boardClimbNeighbors, boardClimbs } from '../../schema/index';
import {
  CLIMB_NEIGHBOR_K,
  CLIMB_NEIGHBOR_MIN_JACCARD,
  ClimbNeighborIndex,
  type NeighborClimb,
} from './climb-neighbors';
import { distinctHoldIds, storedWoodsSizeId } from './frames-hold-entries';

/**
 * The watermark-driven refresh behind `packages/db/scripts/refresh-climb-neighbors.ts`.
 * Lives in the package (not the script) so the backend Vitest suite, which has
 * a real Postgres, can run it end to end. Design: docs/similar-climbs.md.
 *
 * Per board:
 *  1. Work set = every climb whose `sync_seq` moved past the board's watermark
 *     (new, edited, hidden, unlisted, re-listed — the row trigger bumps
 *     `sync_seq` on any real change). `--full`, or a board's first run, makes
 *     it every climb.
 *  2. Rows naming a work-set climb, in either direction, are deleted. The
 *     climbs whose lists lost a row that way are "displaced".
 *  3. Per comparison group (a layout; a layout + wall on Woods) the eligible
 *     climbs are loaded into an in-memory hold index, and every climb whose
 *     top-K can have changed is recomputed from scratch: the work-set climbs,
 *     their above-floor neighbours (the new climb may now rank in their list),
 *     the displaced climbs, and any list now shorter than its stored
 *     `list_size` (a row removed by an edit or a deleted climb).
 *  4. The watermark advances only past rows last written over an hour ago, so
 *     a transaction still open during the run is never skipped.
 *
 * Recomputing a touched list rather than splicing one row into it keeps every
 * list exactly what a full rebuild would write.
 */

export type ClimbNeighborRefreshDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export type ClimbNeighborRefreshOptions = {
  boardType: BoardName;
  /** Rebuild every list on the board, ignoring the watermark. Implied on a board's first run. */
  full?: boolean;
  /** Compute and count, write nothing (watermark included). */
  dryRun?: boolean;
  log?: (line: string) => void;
};

export type ClimbNeighborGroupStat = {
  layoutId: number;
  sizeId: number | null;
  indexedClimbs: number;
  climbsProcessed: number;
  rowsWritten: number;
  seconds: number;
};

export type ClimbNeighborRefreshResult = {
  boardType: BoardName;
  skipped: boolean;
  /** True when this run rebuilt every list (asked for, or the board's first run). */
  full: boolean;
  previousSyncSeq: number;
  nextSyncSeq: number;
  workSetSize: number;
  groups: ClimbNeighborGroupStat[];
  rowsWritten: number;
};

const UUID_CHUNK = 1000;
const INSERT_BATCH = 5000;
const RECOMPUTE_CHUNK = 2000;
/** How old a row's last write must be before the watermark may pass it. */
const WATERMARK_SETTLE_SECONDS = 60 * 60;

type GroupKey = { layoutId: number; sizeId: number | null };
type Group = GroupKey & { members: Set<string> };

function isSizeScopedBoard(boardType: BoardName): boolean {
  return boardType === 'woods';
}

/** The comparison group a climb belongs to, or null when it cannot be placed (a Woods climb with no wall). */
function groupKeyFor(boardType: BoardName, layoutId: number, compatibleSizeIds: number[] | null): GroupKey | null {
  if (!isSizeScopedBoard(boardType)) return { layoutId, sizeId: null };
  const sizeId = storedWoodsSizeId(compatibleSizeIds);
  return sizeId === null ? null : { layoutId, sizeId };
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) chunks.push(items.slice(start, start + size));
  return chunks;
}

function addToGroup(groups: Map<string, Group>, key: GroupKey, uuid: string | null): void {
  const mapKey = `${key.layoutId}:${key.sizeId ?? ''}`;
  let group = groups.get(mapKey);
  if (!group) {
    group = { ...key, members: new Set() };
    groups.set(mapKey, group);
  }
  if (uuid) group.members.add(uuid);
}

async function loadGroupClimbs(
  db: ClimbNeighborRefreshDb,
  boardType: BoardName,
  group: GroupKey,
): Promise<NeighborClimb[]> {
  // The live `findSimilarClimbs` candidate predicate, word for word.
  const rows = await db
    .select({ uuid: boardClimbs.uuid, frames: boardClimbs.frames })
    .from(boardClimbs)
    .where(
      and(
        eq(boardClimbs.boardType, boardType),
        eq(boardClimbs.layoutId, group.layoutId),
        eq(boardClimbs.isDraft, false),
        or(isNull(boardClimbs.isListed), eq(boardClimbs.isListed, true)),
        eq(boardClimbs.isHidden, false),
        eq(boardClimbs.framesCount, 1),
        group.sizeId === null
          ? undefined
          : sql`COALESCE(${boardClimbs.compatibleSizeIds}, '{}'::int[]) @> ARRAY[${group.sizeId}]::int[]`,
      ),
    );
  return rows.map((row) => ({ uuid: row.uuid, holdIds: distinctHoldIds(boardType, row.frames) }));
}

export async function refreshClimbNeighborsForBoard(
  db: ClimbNeighborRefreshDb,
  { boardType, full: requestedFull = false, dryRun = false, log = () => {} }: ClimbNeighborRefreshOptions,
): Promise<ClimbNeighborRefreshResult> {
  const result: ClimbNeighborRefreshResult = {
    boardType,
    skipped: false,
    full: requestedFull,
    previousSyncSeq: 0,
    nextSyncSeq: 0,
    workSetSize: 0,
    groups: [],
    rowsWritten: 0,
  };

  // Spray walls are private per-owner catalogues; nothing about them goes into
  // a table every caller reads from.
  if (boardType === 'spray') {
    log(`[${boardType}] skipped: spray walls are never materialised`);
    return { ...result, skipped: true };
  }

  const [run] = await db
    .select({ lastSyncSeq: boardClimbNeighborRuns.lastSyncSeq })
    .from(boardClimbNeighborRuns)
    .where(eq(boardClimbNeighborRuns.boardType, boardType));
  // A board the job has never run on has nothing to be incremental against:
  // the first scheduled run after the migration builds it in full.
  const full = requestedFull || !run;
  result.full = full;
  const previousSyncSeq = full ? 0 : Number(run?.lastSyncSeq ?? 0);
  result.previousSyncSeq = previousSyncSeq;

  // Two bounds, deliberately different.
  //
  // The work set runs up to the highest sync_seq visible now, so every
  // committed change is scored this run.
  //
  // The watermark only advances past rows last written over an hour ago.
  // sync_seq is assigned by a BEFORE UPDATE trigger (0144) at write time, not
  // at commit: a transaction still open when this run reads can hold seq N
  // while a later one has already committed N+1. Advancing to the plain MAX
  // would skip N forever once it commits. The trigger's updated_at is NOW(),
  // the transaction's start, so any row at or below the max of rows older than
  // an hour belongs to a transaction that started over an hour ago; any
  // transaction shorter than that has committed. Recent rows are simply scored
  // again next run, which is idempotent.
  const [{ highestSyncSeq } = { highestSyncSeq: null }] = await db
    .select({ highestSyncSeq: max(boardClimbs.syncSeq) })
    .from(boardClimbs)
    .where(eq(boardClimbs.boardType, boardType));
  const [{ settledSyncSeq } = { settledSyncSeq: null }] = await db
    .select({ settledSyncSeq: max(boardClimbs.syncSeq) })
    .from(boardClimbs)
    .where(
      and(
        eq(boardClimbs.boardType, boardType),
        lt(boardClimbs.updatedAt, sql`now() - make_interval(secs => ${WATERMARK_SETTLE_SECONDS})`),
      ),
    );
  const workSetUpperSyncSeq = Math.max(previousSyncSeq, Number(highestSyncSeq ?? 0));
  const nextSyncSeq = Math.min(workSetUpperSyncSeq, Math.max(previousSyncSeq, Number(settledSyncSeq ?? 0)));
  result.nextSyncSeq = nextSyncSeq;
  const runStartedAt = new Date();

  const groups = new Map<string, Group>();
  const workSet = new Set<string>();

  if (full) {
    const layouts = await db
      .selectDistinct({ layoutId: boardClimbs.layoutId, compatibleSizeIds: boardClimbs.compatibleSizeIds })
      .from(boardClimbs)
      .where(and(eq(boardClimbs.boardType, boardType), eq(boardClimbs.framesCount, 1), eq(boardClimbs.isDraft, false)));
    for (const { layoutId, compatibleSizeIds } of layouts) {
      const key = groupKeyFor(boardType, layoutId, compatibleSizeIds);
      if (key) addToGroup(groups, key, null);
    }
    log(`[${boardType}] full rebuild over ${groups.size} group(s), sync_seq ≤ ${workSetUpperSyncSeq}`);
  } else {
    const changed = await db
      .select({
        uuid: boardClimbs.uuid,
        layoutId: boardClimbs.layoutId,
        compatibleSizeIds: boardClimbs.compatibleSizeIds,
      })
      .from(boardClimbs)
      .where(
        and(
          eq(boardClimbs.boardType, boardType),
          gt(boardClimbs.syncSeq, previousSyncSeq),
          lte(boardClimbs.syncSeq, workSetUpperSyncSeq),
        ),
      );
    for (const climb of changed) {
      workSet.add(climb.uuid);
      const key = groupKeyFor(boardType, climb.layoutId, climb.compatibleSizeIds);
      if (key) addToGroup(groups, key, climb.uuid);
    }
    result.workSetSize = workSet.size;
    log(`[${boardType}] ${workSet.size} climb(s) changed since sync_seq ${previousSyncSeq}`);

    // Lists shorter than they were written lost a row outside this job:
    // `updateClimb` deletes an edited climb's rows in both directions, and
    // deleting a climb cascades its rows away. By the time the job runs nothing
    // names that climb any more, so `list_size` is the only record of which
    // lists to refill.
    const gapped = await db
      .select({
        uuid: boardClimbNeighbors.climbUuid,
        layoutId: boardClimbs.layoutId,
        compatibleSizeIds: boardClimbs.compatibleSizeIds,
      })
      .from(boardClimbNeighbors)
      .innerJoin(boardClimbs, eq(boardClimbs.uuid, boardClimbNeighbors.climbUuid))
      .where(eq(boardClimbNeighbors.boardType, boardType))
      .groupBy(boardClimbNeighbors.climbUuid, boardClimbs.layoutId, boardClimbs.compatibleSizeIds)
      .having(sql`COUNT(*) <> MAX(${boardClimbNeighbors.listSize})`);
    for (const climb of gapped) {
      const key = groupKeyFor(boardType, climb.layoutId, climb.compatibleSizeIds);
      if (key) addToGroup(groups, key, climb.uuid);
    }
    if (gapped.length > 0) log(`[${boardType}] ${gapped.length} list(s) short of their written size to refill`);

    // Climbs whose list named a work-set climb: they lose that row below and
    // are recomputed so the slot is refilled.
    for (const uuids of chunk([...workSet], UUID_CHUNK)) {
      const displaced = await db
        .selectDistinct({
          uuid: boardClimbNeighbors.climbUuid,
          layoutId: boardClimbs.layoutId,
          compatibleSizeIds: boardClimbs.compatibleSizeIds,
        })
        .from(boardClimbNeighbors)
        .innerJoin(boardClimbs, eq(boardClimbs.uuid, boardClimbNeighbors.climbUuid))
        .where(and(eq(boardClimbNeighbors.boardType, boardType), inArray(boardClimbNeighbors.neighborUuid, uuids)));
      for (const climb of displaced) {
        const key = groupKeyFor(boardType, climb.layoutId, climb.compatibleSizeIds);
        if (key) addToGroup(groups, key, climb.uuid);
      }
      if (!dryRun) {
        await db
          .delete(boardClimbNeighbors)
          .where(
            and(
              eq(boardClimbNeighbors.boardType, boardType),
              or(inArray(boardClimbNeighbors.climbUuid, uuids), inArray(boardClimbNeighbors.neighborUuid, uuids)),
            ),
          );
      }
    }
  }

  for (const group of groups.values()) {
    const startedAt = Date.now();
    const index = new ClimbNeighborIndex(await loadGroupClimbs(db, boardType, group));

    // Which lists to (re)write in this group.
    let recompute: string[];
    if (full) {
      recompute = index.uuids();
    } else {
      const touched = new Set<string>();
      for (const uuid of group.members) {
        if (!index.has(uuid)) continue;
        touched.add(uuid);
        if (workSet.has(uuid)) {
          for (const neighbor of index.neighborsOf(uuid)) touched.add(neighbor.neighborUuid);
        }
      }
      recompute = [...touched];
    }

    let rowsWritten = 0;
    for (const uuids of chunk(recompute, RECOMPUTE_CHUNK)) {
      const rows: (typeof boardClimbNeighbors.$inferInsert)[] = [];
      for (const uuid of uuids) {
        const list = index.neighborsOf(uuid, CLIMB_NEIGHBOR_MIN_JACCARD).slice(0, CLIMB_NEIGHBOR_K);
        list.forEach((neighbor, position) => {
          rows.push({
            boardType,
            climbUuid: uuid,
            neighborUuid: neighbor.neighborUuid,
            sharedHoldCount: neighbor.sharedHoldCount,
            targetHoldCount: neighbor.targetHoldCount,
            candidateHoldCount: neighbor.candidateHoldCount,
            jaccard: neighbor.jaccard,
            rank: position + 1,
            listSize: list.length,
            computedAt: runStartedAt,
          });
        });
      }
      rowsWritten += rows.length;
      if (dryRun) continue;
      // One transaction per chunk: a reader sees a climb's old list or its new
      // one, never an empty gap between the delete and the insert.
      await db.transaction(async (tx) => {
        await tx
          .delete(boardClimbNeighbors)
          .where(and(eq(boardClimbNeighbors.boardType, boardType), inArray(boardClimbNeighbors.climbUuid, uuids)));
        for (const batch of chunk(rows, INSERT_BATCH)) {
          await tx.insert(boardClimbNeighbors).values(batch);
        }
      });
    }

    const stat: ClimbNeighborGroupStat = {
      layoutId: group.layoutId,
      sizeId: group.sizeId,
      indexedClimbs: index.size,
      climbsProcessed: recompute.length,
      rowsWritten,
      seconds: (Date.now() - startedAt) / 1000,
    };
    result.groups.push(stat);
    result.rowsWritten += rowsWritten;
    log(
      `[${boardType}] layout ${group.layoutId}${group.sizeId === null ? '' : ` size ${group.sizeId}`}: ` +
        `${stat.climbsProcessed} climbs processed of ${stat.indexedClimbs} indexed, ` +
        `${stat.rowsWritten} rows ${dryRun ? 'computed' : 'written'}, ${stat.seconds.toFixed(1)}s`,
    );
  }

  if (dryRun) {
    log(`[${boardType}] dry run: nothing written, watermark stays at ${run?.lastSyncSeq ?? 0}`);
    return result;
  }

  if (full) {
    // Every list this run wrote carries runStartedAt; anything older belongs to
    // a climb that is no longer eligible (hidden, unlisted, drafted, gone multi-frame).
    await db
      .delete(boardClimbNeighbors)
      .where(and(eq(boardClimbNeighbors.boardType, boardType), lt(boardClimbNeighbors.computedAt, runStartedAt)));
  }

  await db
    .insert(boardClimbNeighborRuns)
    .values({ boardType, lastSyncSeq: nextSyncSeq, computedAt: new Date() })
    .onConflictDoUpdate({
      target: boardClimbNeighborRuns.boardType,
      set: { lastSyncSeq: nextSyncSeq, computedAt: new Date() },
    });
  log(`[${boardType}] watermark ${previousSyncSeq} → ${nextSyncSeq}, ${result.rowsWritten} rows written`);
  return result;
}
