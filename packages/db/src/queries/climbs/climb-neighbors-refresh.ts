import { and, count, eq, gt, gte, inArray, isNull, lt, lte, max, or, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { SUPPORTED_BOARDS, type BoardName } from '@boardsesh/shared-schema';
import {
  boardClimbNeighborGroupRuns,
  boardClimbNeighborRuns,
  boardClimbNeighbors,
  boardClimbs,
} from '../../schema/index';
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
 * A full build is resumable: it pins its start time and watermark target in
 * `board_climb_neighbor_runs`, records each finished group in
 * `board_climb_neighbor_group_runs`, and a later run skips finished groups and
 * lists already written by the same build.
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
  /**
   * Checked before each chunk of lists. Returning false stops the run where it
   * is, as a cancelled CI job would: finished chunks and groups stay recorded,
   * the watermark does not move, and the next run resumes the build.
   */
  shouldContinue?: () => boolean;
  /** Lists written per transaction. Tests shrink it to stop mid-group. */
  chunkSize?: number;
  /**
   * Incremental runs only: also scan the whole board for lists shorter than
   * their `list_size` and refill them. The scan reads every row on the board
   * (Kilter: 192k rows, 20-36 s), and since `updateClimb` stopped deleting other
   * climbs' rows the only source of such gaps is a deleted climb's FK cascade,
   * a handful a week. The script turns it on once a week
   * ({@link isGapRefillDay}) and on `--refill-gaps`. Defaults to true.
   */
  refillGappedLists?: boolean;
};

/** UTC day of week (0 = Sunday) on which the nightly run also refills gapped lists. */
export const CLIMB_NEIGHBOR_GAP_REFILL_UTC_DAY = 0;

/** Whether a nightly run starting at `now` is the weekly gap-refill run. */
export function isGapRefillDay(now: Date): boolean {
  return now.getUTCDay() === CLIMB_NEIGHBOR_GAP_REFILL_UTC_DAY;
}

export type ClimbNeighborGroupStat = {
  layoutId: number;
  sizeId: number | null;
  indexedClimbs: number;
  climbsProcessed: number;
  /** Full build only: climbs a previous, cancelled run of the same build already wrote. */
  climbsSkipped: number;
  /** Full build only: the whole group was finished by a previous run of the same build. */
  alreadyComplete: boolean;
  rowsWritten: number;
  seconds: number;
};

export type ClimbNeighborRefreshResult = {
  boardType: BoardName;
  skipped: boolean;
  /** True when this run rebuilt every list (asked for, the board's first run, or resuming either). */
  full: boolean;
  /** True when this run picked up a full build a previous run started and did not finish. */
  resumed: boolean;
  previousSyncSeq: number;
  nextSyncSeq: number;
  workSetSize: number;
  groups: ClimbNeighborGroupStat[];
  rowsWritten: number;
  /** `shouldContinue` stopped the run before the board was done. */
  interrupted: boolean;
};

const UUID_CHUNK = 1000;
const INSERT_BATCH = 5000;
const RECOMPUTE_CHUNK = 1000;
/** Progress line cadence within a group. */
const PROGRESS_EVERY = 5000;
/** How old a row's last write must be before the watermark may pass it. */
const WATERMARK_SETTLE_SECONDS = 60 * 60;

type GroupKey = { layoutId: number; sizeId: number | null };
type Group = GroupKey & { members: Set<string>; eligibleClimbs: number };

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

function groupMapKey(key: GroupKey): string {
  return `${key.layoutId}:${key.sizeId ?? ''}`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '?';
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m${Math.round(seconds % 60)}s` : `${seconds.toFixed(1)}s`;
}

function addToGroup(groups: Map<string, Group>, key: GroupKey, uuid: string | null): void {
  const mapKey = groupMapKey(key);
  let group = groups.get(mapKey);
  if (!group) {
    group = { ...key, members: new Set(), eligibleClimbs: 0 };
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

/**
 * Every board the job materialises: all but spray, whose walls are private.
 * `.github/workflows/refresh-climb-neighbors.yml` runs one matrix job per entry
 * (pinned by climb-neighbors-workflow.test.ts in the backend suite).
 */
export const CLIMB_NEIGHBOR_BOARDS: readonly BoardName[] = SUPPORTED_BOARDS.filter((board) => board !== 'spray');

/**
 * Order boards cheapest first (fewest published single-frame climbs), so a
 * single process that runs several boards serves the small ones before it
 * spends hours on Kilter.
 */
export async function orderBoardsByClimbCount(
  db: ClimbNeighborRefreshDb,
  boards: readonly BoardName[],
): Promise<BoardName[]> {
  if (boards.length < 2) return [...boards];
  const counts = await db
    .select({ boardType: boardClimbs.boardType, climbs: count() })
    .from(boardClimbs)
    .where(
      and(inArray(boardClimbs.boardType, [...boards]), eq(boardClimbs.isDraft, false), eq(boardClimbs.framesCount, 1)),
    )
    .groupBy(boardClimbs.boardType);
  const countByBoard = new Map(counts.map(({ boardType, climbs }) => [boardType, Number(climbs)]));
  return [...boards].sort(
    (left, right) => (countByBoard.get(left) ?? 0) - (countByBoard.get(right) ?? 0) || left.localeCompare(right),
  );
}

export async function refreshClimbNeighborsForBoard(
  db: ClimbNeighborRefreshDb,
  {
    boardType,
    full: requestedFull = false,
    dryRun = false,
    log = () => {},
    shouldContinue = () => true,
    chunkSize = RECOMPUTE_CHUNK,
    refillGappedLists = true,
  }: ClimbNeighborRefreshOptions,
): Promise<ClimbNeighborRefreshResult> {
  const result: ClimbNeighborRefreshResult = {
    boardType,
    skipped: false,
    full: requestedFull,
    resumed: false,
    previousSyncSeq: 0,
    nextSyncSeq: 0,
    workSetSize: 0,
    groups: [],
    rowsWritten: 0,
    interrupted: false,
  };

  // Spray walls are private per-owner catalogues; nothing about them goes into
  // a table every caller reads from.
  if (boardType === 'spray') {
    log(`[${boardType}] skipped: spray walls are never materialised`);
    return { ...result, skipped: true };
  }

  const [run] = await db
    .select({
      lastSyncSeq: boardClimbNeighborRuns.lastSyncSeq,
      fullBuildStartedAt: boardClimbNeighborRuns.fullBuildStartedAt,
      fullBuildSyncSeq: boardClimbNeighborRuns.fullBuildSyncSeq,
    })
    .from(boardClimbNeighborRuns)
    .where(eq(boardClimbNeighborRuns.boardType, boardType));
  // A full build a previous run started and did not finish is resumed, whatever
  // this run was asked for. Otherwise a board the job has never finished has
  // nothing to be incremental against, so its first run builds in full.
  const resuming = run?.fullBuildStartedAt != null && run.fullBuildSyncSeq != null;
  const full = resuming || requestedFull || !run;
  result.full = full;
  result.resumed = resuming;
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
  // A resumed build keeps the target it pinned when it started: climbs that
  // changed since are above it, so the first incremental run after the build
  // folds them into the lists this build wrote before they existed.
  const nextSyncSeq = resuming
    ? Number(run.fullBuildSyncSeq)
    : Math.min(workSetUpperSyncSeq, Math.max(previousSyncSeq, Number(settledSyncSeq ?? 0)));
  result.nextSyncSeq = nextSyncSeq;
  const runStartedAt = new Date();
  // Rows this build has written carry computed_at >= buildStartedAt, which is
  // how a resumed run recognises finished climbs and how the end-of-build
  // sweep recognises stale ones.
  const buildStartedAt = resuming && run.fullBuildStartedAt ? run.fullBuildStartedAt : runStartedAt;

  if (full && !resuming && !dryRun) {
    await db
      .insert(boardClimbNeighborRuns)
      .values({ boardType, lastSyncSeq: 0, fullBuildStartedAt: buildStartedAt, fullBuildSyncSeq: nextSyncSeq })
      .onConflictDoUpdate({
        target: boardClimbNeighborRuns.boardType,
        set: { fullBuildStartedAt: buildStartedAt, fullBuildSyncSeq: nextSyncSeq },
      });
  }

  const groups = new Map<string, Group>();
  const workSet = new Set<string>();

  // Full build only: groups and climbs a previous run of this build finished.
  const completedGroups = new Set<string>();
  const finishedClimbs = new Set<string>();

  if (full) {
    const layouts = await db
      .select({
        layoutId: boardClimbs.layoutId,
        compatibleSizeIds: boardClimbs.compatibleSizeIds,
        climbs: count(),
      })
      .from(boardClimbs)
      .where(and(eq(boardClimbs.boardType, boardType), eq(boardClimbs.framesCount, 1), eq(boardClimbs.isDraft, false)))
      .groupBy(boardClimbs.layoutId, boardClimbs.compatibleSizeIds);
    for (const { layoutId, compatibleSizeIds, climbs } of layouts) {
      const key = groupKeyFor(boardType, layoutId, compatibleSizeIds);
      if (!key) continue;
      addToGroup(groups, key, null);
      const group = groups.get(groupMapKey(key));
      if (group) group.eligibleClimbs += Number(climbs);
    }
    if (resuming) {
      const doneGroups = await db
        .select({ layoutId: boardClimbNeighborGroupRuns.layoutId, sizeId: boardClimbNeighborGroupRuns.sizeId })
        .from(boardClimbNeighborGroupRuns)
        .where(
          and(
            eq(boardClimbNeighborGroupRuns.boardType, boardType),
            gte(boardClimbNeighborGroupRuns.completedAt, buildStartedAt),
          ),
        );
      for (const { layoutId, sizeId } of doneGroups) {
        completedGroups.add(groupMapKey({ layoutId, sizeId: sizeId === 0 ? null : sizeId }));
      }
      const doneClimbs = await db
        .selectDistinct({ uuid: boardClimbNeighbors.climbUuid })
        .from(boardClimbNeighbors)
        .where(and(eq(boardClimbNeighbors.boardType, boardType), gte(boardClimbNeighbors.computedAt, buildStartedAt)));
      for (const { uuid } of doneClimbs) finishedClimbs.add(uuid);
    }
    log(
      `[${boardType}] ${resuming ? 'resuming' : 'starting'} full build over ${groups.size} group(s), ` +
        `watermark target sync_seq ${nextSyncSeq}` +
        (resuming ? `, ${completedGroups.size} group(s) and ${finishedClimbs.size} list(s) already done` : ''),
    );
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

    // Lists shorter than they were written lost a row outside this job: a
    // deleted climb cascades its rows away, and by the time the job runs nothing
    // names that climb any more, so `list_size` is the only record of which
    // lists to refill. A list that lost a row is still correct, one entry
    // short, and clients show 10-12 of 25, so this whole-board scan runs weekly.
    if (refillGappedLists) {
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
      log(`[${boardType}] gap scan: ${gapped.length} list(s) short of their written size to refill`);
    }

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

  // Smallest groups first, so the cheap ones are served first and a cancelled
  // run has finished (and recorded) as many groups as it could.
  const orderedGroups = [...groups.values()].sort(
    (left, right) => left.eligibleClimbs - right.eligibleClimbs || left.layoutId - right.layoutId,
  );

  for (const group of orderedGroups) {
    const groupLabel = `layout ${group.layoutId}${group.sizeId === null ? '' : ` size ${group.sizeId}`}`;
    if (completedGroups.has(groupMapKey(group))) {
      result.groups.push({
        layoutId: group.layoutId,
        sizeId: group.sizeId,
        indexedClimbs: 0,
        climbsProcessed: 0,
        climbsSkipped: 0,
        alreadyComplete: true,
        rowsWritten: 0,
        seconds: 0,
      });
      log(`[${boardType}] ${groupLabel}: already finished by this build, skipped`);
      continue;
    }
    const startedAt = Date.now();
    const index = new ClimbNeighborIndex(await loadGroupClimbs(db, boardType, group));

    // Which lists to (re)write in this group.
    let recompute: string[];
    let climbsSkipped = 0;
    if (full) {
      const all = index.uuids();
      recompute = all.filter((uuid) => !finishedClimbs.has(uuid));
      climbsSkipped = all.length - recompute.length;
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
    if (recompute.length >= PROGRESS_EVERY) {
      log(
        `[${boardType}] ${groupLabel}: ${recompute.length} lists to write of ${index.size} indexed` +
          (climbsSkipped > 0 ? ` (${climbsSkipped} already written by this build)` : ''),
      );
    }

    let rowsWritten = 0;
    let climbsDone = 0;
    let nextProgressAt = PROGRESS_EVERY;
    for (const uuids of chunk(recompute, chunkSize)) {
      if (!shouldContinue()) {
        result.interrupted = true;
        break;
      }
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
      climbsDone += uuids.length;
      if (!dryRun) {
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
      if (climbsDone >= nextProgressAt && climbsDone < recompute.length) {
        nextProgressAt += PROGRESS_EVERY;
        const elapsed = (Date.now() - startedAt) / 1000;
        const rate = climbsDone / Math.max(elapsed, 0.001);
        log(
          `[${boardType}] ${groupLabel}: ${climbsDone}/${recompute.length} climbs, ${rowsWritten} rows, ` +
            `${formatDuration(elapsed)} elapsed, ${rate.toFixed(0)} climbs/s, ` +
            `ETA ${formatDuration((recompute.length - climbsDone) / rate)}`,
        );
      }
    }

    if (full && !dryRun && !result.interrupted) {
      await db
        .insert(boardClimbNeighborGroupRuns)
        .values({ boardType, layoutId: group.layoutId, sizeId: group.sizeId ?? 0, completedAt: new Date() })
        .onConflictDoUpdate({
          target: [
            boardClimbNeighborGroupRuns.boardType,
            boardClimbNeighborGroupRuns.layoutId,
            boardClimbNeighborGroupRuns.sizeId,
          ],
          set: { completedAt: new Date() },
        });
    }

    const stat: ClimbNeighborGroupStat = {
      layoutId: group.layoutId,
      sizeId: group.sizeId,
      indexedClimbs: index.size,
      climbsProcessed: recompute.length,
      climbsSkipped,
      alreadyComplete: false,
      rowsWritten,
      seconds: (Date.now() - startedAt) / 1000,
    };
    result.groups.push(stat);
    result.rowsWritten += rowsWritten;
    log(
      `[${boardType}] ${groupLabel}: ` +
        `${stat.climbsProcessed} climbs processed of ${stat.indexedClimbs} indexed, ` +
        `${stat.rowsWritten} rows ${dryRun ? 'computed' : 'written'}, ${stat.seconds.toFixed(1)}s` +
        (result.interrupted ? ' (stopped before the group finished)' : ''),
    );
    if (result.interrupted) break;
  }

  if (result.interrupted) {
    log(
      `[${boardType}] stopped early: ${result.rowsWritten} rows written, watermark unchanged` +
        (full ? '; the next run resumes this build' : ''),
    );
    return result;
  }

  if (dryRun) {
    log(`[${boardType}] dry run: nothing written, watermark stays at ${run?.lastSyncSeq ?? 0}`);
    return result;
  }

  if (full) {
    // Every list this build wrote carries computed_at >= buildStartedAt (across
    // every resumed run of it); anything older belongs to a climb that is no
    // longer eligible (hidden, unlisted, drafted, gone multi-frame).
    await db
      .delete(boardClimbNeighbors)
      .where(and(eq(boardClimbNeighbors.boardType, boardType), lt(boardClimbNeighbors.computedAt, buildStartedAt)));
  }

  // The watermark moves only here, once every group on the board is done.
  await db
    .insert(boardClimbNeighborRuns)
    .values({ boardType, lastSyncSeq: nextSyncSeq, computedAt: new Date() })
    .onConflictDoUpdate({
      target: boardClimbNeighborRuns.boardType,
      set: { lastSyncSeq: nextSyncSeq, computedAt: new Date(), fullBuildStartedAt: null, fullBuildSyncSeq: null },
    });
  log(`[${boardType}] watermark ${previousSyncSeq} → ${nextSyncSeq}, ${result.rowsWritten} rows written`);
  return result;
}
