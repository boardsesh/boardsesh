/**
 * Re-file ticks that landed on a per-config SHARED FEED board onto
 * the active matching session wall, or their climber's unique matching wall.
 *
 * Prepares tooling for the historical data half of #5121. The code path was fixed in the same issue's
 * first PR; this is the separate decision about the rows already written.
 *
 * A wall with no BLE serial — every MoonBoard, and any serial-less
 * Kilter/Tension controller — binds board presence through the backend's
 * `resolveBoardForConfig`, which hands back ONE system-owned row per
 * (board type, layout, size, sets), shared by every climber on that
 * configuration worldwide. The mobile tick sheet sent that row's id and
 * `saveTick` let it win outright, so a climber with their own board of that
 * exact config had every tick filed under the global feed. Their board then
 * reads as empty everywhere it is scoped by `board_id` — the Home tab's board
 * picker ("Quiet on <board> right now"), board stats, board leaderboards.
 *
 * Measured on production 2026-09-07: 12,648 ticks sit on 31 shared feeds, and
 * 10,879 of them (655 climbers) belong to someone who owns a board of that
 * exact configuration.
 *
 * The rule follows saveTick's session-before-owned-board resolution: an active
 * session board with the same full config wins, even when another climber owns
 * it. Otherwise require EXACTLY ONE non-deleted owned board with the same
 * (board_type, layout_id, size_id, normalised set_ids). Without a usable session,
 * two owned same-config boards (#4174) are ambiguous and remain on the feed,
 * as do ticks with no matching owned board.
 *
 * Set ids are compared normalised, not as raw strings. `createBoard` stores
 * whatever order it was handed, so a board saved as '25,26,27,24' is the same
 * wall as a feed keyed '24,25,26,27'.
 *
 * The original author recorded maintainer approval on 2026-09-07. That
 * historical context does not authorize a current production run.
 *
 * Usage (needs a DB_URL with UPDATE rights — the usual read-only credential can
 * run --dry-run but not the apply step):
 *   vp run db:backfill-shared-feed-tick-boards -- --dry-run
 *   vp run db:backfill-shared-feed-tick-boards -- --apply
 *   vp run db:backfill-shared-feed-tick-boards -- --revert <snapshot.json> --apply
 *
 * Options:
 *   --apply          Enable database writes (forward or revert).
 *   --dry-run        Default: match and report, write no database rows. Still writes the plan file.
 *   --revert <file>  Preview a prior snapshot; add --apply to restore board ids.
 *   --out <file>     Snapshot path (default ./shared-feed-tick-boards-<plan|apply>-<timestamp>.json).
 *
 * A tick already moved off the feed stops matching. Use a new --out path on
 * every run: existing plan/recovery files are never overwritten.
 *
 * Forward applies re-read and re-plan their still-source rows in a SERIALIZABLE
 * transaction. If a resolved wall changed, take a fresh dry-run and review its
 * new snapshot; this tool never retries an old plan or picks a replacement.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { resolve } from 'path';
import { and, eq, inArray, isNull, like } from 'drizzle-orm';
import { createScriptDb } from './db-connection.js';
import {
  boardConfigKey,
  planSharedFeedTickMoves,
  type FeedTick,
  type OwnedBoard,
  type PlannedMove,
  type SharedFeedBoard,
} from './backfill-shared-feed-tick-boards-helpers.js';
import { boardseshTicks } from '../src/schema/app/ascents.js';
import { userBoards } from '../src/schema/app/boards.js';
import { boardSessions } from '../src/schema/app/sessions.js';

// Mirrors the backend's `SYSTEM_BOARD_OWNER_ID` and
// `BOARD_CONFIG_PRESENCE_SLUG_PREFIX` (graphql/resolvers/board-presence/shared.ts).
// Duplicated rather than imported: packages/db must not depend on the backend.
// Identity is owner + slug namespace, never the display name — the ~520 seeded
// catalog boards are system-owned too and name real walls.
const SYSTEM_BOARD_OWNER_ID = '00000000-0000-0000-0000-000000000000';
const PRESENCE_SLUG_PREFIX = 'presence-';

export type RepairOptions = { apply: boolean; revertPath?: string; outPath?: string; help: boolean };

export function parseArgs(args: string[]): RepairOptions {
  const options: RepairOptions = { apply: false, help: false };
  let explicitDryRun = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--') continue;
    if (argument === '--apply') options.apply = true;
    else if (argument === '--dry-run') explicitDryRun = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--revert' || argument === '--out') {
      const filename = args[++index];
      if (!filename || filename.startsWith('--')) throw new Error(`${argument} requires a filename`);
      if (argument === '--revert') options.revertPath = filename;
      else options.outPath = filename;
    } else throw new Error(`Unknown option: ${argument}`);
  }
  if (options.apply && explicitDryRun) throw new Error('--apply and --dry-run cannot be combined');
  return options;
}

const HELP = `Re-file shared-feed ticks. Dry-run is the default; database writes require --apply.
  --apply         Apply the forward plan or the selected revert.
  --dry-run       Explicitly select the default read-only database mode.
  --revert <file> Restore a prior snapshot (dry-run unless --apply is supplied).
  --out <file>    New snapshot path; existing files are never overwritten.
  --help          Show this help without connecting to a database.`;

const BATCH_SIZE = 500;
type ScriptDb = ReturnType<typeof createScriptDb>['db'];
type ScriptTransaction = Parameters<Parameters<ScriptDb['transaction']>[0]>[0];

export type ForwardMovePlan = {
  feeds: SharedFeedBoard[];
  entries: PlannedMove[];
};

/** Match saveTick's session rung: another user's session is valid, deleted walls are not. */
export async function loadSharedFeedTicks(db: Pick<ScriptDb, 'select'>, feedIds: number[]): Promise<FeedTick[]> {
  const ticks = await db
    .select({
      uuid: boardseshTicks.uuid,
      userId: boardseshTicks.userId,
      boardId: boardseshTicks.boardId,
      sessionBoard: {
        id: userBoards.id,
        boardType: userBoards.boardType,
        layoutId: userBoards.layoutId,
        sizeId: userBoards.sizeId,
        setIds: userBoards.setIds,
      },
    })
    .from(boardseshTicks)
    .leftJoin(boardSessions, eq(boardSessions.id, boardseshTicks.sessionId))
    .leftJoin(userBoards, and(eq(userBoards.id, boardSessions.boardId), isNull(userBoards.deletedAt)))
    .where(inArray(boardseshTicks.boardId, feedIds));
  return ticks.map((tick) => ({ ...tick, boardId: Number(tick.boardId) }));
}

async function loadTicksByUuid(db: Pick<ScriptDb, 'select'>, uuids: string[]): Promise<FeedTick[]> {
  const ticks: FeedTick[] = [];
  for (let offset = 0; offset < uuids.length; offset += BATCH_SIZE) {
    const rows = await db
      .select({
        uuid: boardseshTicks.uuid,
        userId: boardseshTicks.userId,
        boardId: boardseshTicks.boardId,
        sessionBoard: {
          id: userBoards.id,
          boardType: userBoards.boardType,
          layoutId: userBoards.layoutId,
          sizeId: userBoards.sizeId,
          setIds: userBoards.setIds,
        },
      })
      .from(boardseshTicks)
      .leftJoin(boardSessions, eq(boardSessions.id, boardseshTicks.sessionId))
      .leftJoin(userBoards, and(eq(userBoards.id, boardSessions.boardId), isNull(userBoards.deletedAt)))
      .where(inArray(boardseshTicks.uuid, uuids.slice(offset, offset + BATCH_SIZE)));
    ticks.push(...rows.map((tick) => ({ ...tick, boardId: Number(tick.boardId) })));
  }
  return ticks;
}

async function loadCurrentSharedFeeds(db: Pick<ScriptDb, 'select'>, feedIds: number[]): Promise<SharedFeedBoard[]> {
  const feeds: SharedFeedBoard[] = [];
  for (let offset = 0; offset < feedIds.length; offset += BATCH_SIZE) {
    const rows = await db
      .select({
        id: userBoards.id,
        boardType: userBoards.boardType,
        layoutId: userBoards.layoutId,
        sizeId: userBoards.sizeId,
        setIds: userBoards.setIds,
      })
      .from(userBoards)
      .where(
        and(
          inArray(userBoards.id, feedIds.slice(offset, offset + BATCH_SIZE)),
          eq(userBoards.ownerId, SYSTEM_BOARD_OWNER_ID),
          like(userBoards.slug, `${PRESENCE_SLUG_PREFIX}%`),
        ),
      );
    feeds.push(
      ...rows.map((feed) => ({
        id: Number(feed.id),
        boardType: feed.boardType,
        layoutId: Number(feed.layoutId),
        sizeId: Number(feed.sizeId),
        setIds: feed.setIds,
      })),
    );
  }
  return feeds;
}

async function loadOwnedBoards(db: Pick<ScriptDb, 'select'>, ownerIds: string[]): Promise<OwnedBoard[]> {
  const boards: OwnedBoard[] = [];
  for (let offset = 0; offset < ownerIds.length; offset += BATCH_SIZE) {
    const rows = await db
      .select({
        id: userBoards.id,
        ownerId: userBoards.ownerId,
        boardType: userBoards.boardType,
        layoutId: userBoards.layoutId,
        sizeId: userBoards.sizeId,
        setIds: userBoards.setIds,
      })
      .from(userBoards)
      .where(
        and(inArray(userBoards.ownerId, ownerIds.slice(offset, offset + BATCH_SIZE)), isNull(userBoards.deletedAt)),
      );
    boards.push(
      ...rows.map((board) => ({
        id: Number(board.id),
        ownerId: board.ownerId,
        boardType: board.boardType,
        layoutId: Number(board.layoutId),
        sizeId: Number(board.sizeId),
        setIds: board.setIds,
      })),
    );
  }
  return boards;
}

function staleForwardPlan(message: string): Error {
  return new Error(`Forward plan is stale: ${message}. Run a fresh dry-run and review its new snapshot.`);
}

async function revalidateForwardPlan(
  transaction: Pick<ScriptTransaction, 'select'>,
  plan: ForwardMovePlan,
): Promise<PlannedMove[]> {
  const plannedByUuid = new Map(plan.entries.map((entry) => [entry.uuid, entry]));
  const originalFeedById = new Map(plan.feeds.map((feed) => [feed.id, feed]));
  const ticks = await loadTicksByUuid(
    transaction,
    plan.entries.map((entry) => entry.uuid),
  );
  const stillOnSource = ticks.filter((tick) => plannedByUuid.get(tick.uuid)?.oldBoardId === tick.boardId);
  if (stillOnSource.length === 0) return [];

  const sourceFeedIds = [...new Set(stillOnSource.map((tick) => tick.boardId))];
  const currentFeeds = await loadCurrentSharedFeeds(transaction, sourceFeedIds);
  const currentFeedById = new Map(currentFeeds.map((feed) => [feed.id, feed]));
  for (const feedId of sourceFeedIds) {
    const originalFeed = originalFeedById.get(feedId);
    const currentFeed = currentFeedById.get(feedId);
    if (!originalFeed || !currentFeed || boardConfigKey(originalFeed) !== boardConfigKey(currentFeed)) {
      throw staleForwardPlan(`shared feed ${feedId} changed`);
    }
  }

  const ownerIds = [...new Set(stillOnSource.map((tick) => tick.userId))].filter(
    (ownerId) => ownerId !== SYSTEM_BOARD_OWNER_ID,
  );
  const currentPlan = planSharedFeedTickMoves({
    feeds: currentFeeds,
    ticks: stillOnSource,
    ownedBoards: await loadOwnedBoards(transaction, ownerIds),
  });
  const currentMoveByUuid = new Map(currentPlan.moves.map((entry) => [entry.uuid, entry]));
  for (const tick of stillOnSource) {
    const original = plannedByUuid.get(tick.uuid);
    const current = currentMoveByUuid.get(tick.uuid);
    if (
      !original ||
      !current ||
      current.oldBoardId !== original.oldBoardId ||
      current.newBoardId !== original.newBoardId
    ) {
      throw staleForwardPlan(`destination for tick ${tick.uuid} changed`);
    }
  }
  const stillOnSourceUuids = new Set(stillOnSource.map((tick) => tick.uuid));
  return plan.entries.filter((entry) => stillOnSourceUuids.has(entry.uuid));
}

async function applyMoveBatchesInTransaction(
  transaction: Pick<ScriptTransaction, 'update'>,
  entries: PlannedMove[],
  direction: 'forward' | 'revert',
): Promise<number> {
  const groups = new Map<string, { fromBoardId: number; toBoardId: number; uuids: string[] }>();
  for (const entry of entries) {
    const fromBoardId = direction === 'forward' ? entry.oldBoardId : entry.newBoardId;
    const toBoardId = direction === 'forward' ? entry.newBoardId : entry.oldBoardId;
    const key = `${fromBoardId}|${toBoardId}`;
    const group = groups.get(key);
    if (group) group.uuids.push(entry.uuid);
    else groups.set(key, { fromBoardId, toBoardId, uuids: [entry.uuid] });
  }
  const updatedAt = new Date().toISOString();
  let applied = 0;
  for (const { fromBoardId, toBoardId, uuids } of groups.values()) {
    for (let offset = 0; offset < uuids.length; offset += BATCH_SIZE) {
      const rows = await transaction
        .update(boardseshTicks)
        .set({ boardId: toBoardId, updatedAt })
        .where(
          and(
            inArray(boardseshTicks.uuid, uuids.slice(offset, offset + BATCH_SIZE)),
            eq(boardseshTicks.boardId, fromBoardId),
          ),
        )
        .returning({ uuid: boardseshTicks.uuid });
      applied += rows.length;
    }
  }
  return applied;
}

/** Revert restores a reviewed snapshot atomically and retains its current-board guard. */
export async function applyRevertMoveBatches(
  db: Pick<ScriptDb, 'transaction'>,
  entries: PlannedMove[],
): Promise<number> {
  return db.transaction((transaction) => applyMoveBatchesInTransaction(transaction, entries, 'revert'));
}

/**
 * Forward writes re-check the plan under SERIALIZABLE isolation. A serialization
 * failure or changed destination requires a newly reviewed dry-run; retrying an
 * old snapshot could apply a destination the climber no longer selected.
 */
export async function applyForwardMoveBatches(
  db: Pick<ScriptDb, 'transaction'>,
  plan: ForwardMovePlan,
): Promise<number> {
  return db.transaction(
    async (transaction) => {
      const entries = await revalidateForwardPlan(transaction, plan);
      return applyMoveBatchesInTransaction(transaction, entries, 'forward');
    },
    { isolationLevel: 'serializable' },
  );
}

type SnapshotEntry = { uuid: string; oldBoardId: number; newBoardId: number };
type Snapshot = { writtenAt: string; entries: SnapshotEntry[] };

/** Validate the complete recovery plan before creating a database connection. */
export function parseSnapshot(contents: string): Snapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error('Invalid snapshot: expected valid JSON.');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    !('writtenAt' in parsed) ||
    typeof parsed.writtenAt !== 'string' ||
    !Number.isFinite(Date.parse(parsed.writtenAt)) ||
    !('entries' in parsed) ||
    !Array.isArray(parsed.entries)
  ) {
    throw new Error('Invalid snapshot: expected writtenAt timestamp and entries array.');
  }
  const entries: SnapshotEntry[] = parsed.entries.map((entry: unknown, index) => {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !('uuid' in entry) ||
      typeof entry.uuid !== 'string' ||
      entry.uuid.trim().length === 0 ||
      !('oldBoardId' in entry) ||
      typeof entry.oldBoardId !== 'number' ||
      !Number.isSafeInteger(entry.oldBoardId) ||
      entry.oldBoardId <= 0 ||
      !('newBoardId' in entry) ||
      typeof entry.newBoardId !== 'number' ||
      !Number.isSafeInteger(entry.newBoardId) ||
      entry.newBoardId <= 0
    ) {
      throw new Error(`Invalid snapshot entry ${index + 1}: expected uuid and positive safe-integer board IDs.`);
    }
    return { uuid: entry.uuid, oldBoardId: entry.oldBoardId, newBoardId: entry.newBoardId };
  });
  return { writtenAt: parsed.writtenAt, entries };
}

export function resolveSnapshotPath(options: Pick<RepairOptions, 'apply' | 'outPath'>, now = new Date()): string {
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  const snapshotPath =
    options.outPath ?? `./shared-feed-tick-boards-${options.apply ? 'apply' : 'plan'}-${timestamp}.json`;
  if (existsSync(snapshotPath)) {
    throw new Error(`Snapshot already exists: ${snapshotPath}. Choose a new --out path to preserve recovery files.`);
  }
  return snapshotPath;
}

export function writeSnapshot(snapshotPath: string, snapshot: Snapshot): void {
  try {
    writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), { flag: 'wx' });
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw new Error(`Snapshot already exists: ${snapshotPath}. Choose a new --out path to preserve recovery files.`);
    }
    throw error;
  }
}

async function revert(snapshotPath: string, apply: boolean) {
  const snapshot = parseSnapshot(readFileSync(snapshotPath, 'utf8'));
  const { db, close } = createScriptDb();
  try {
    console.log(`Reverting ${snapshot.entries.length} rows from ${snapshotPath} (written ${snapshot.writtenAt})`);
    if (!apply) {
      console.log('Dry run — nothing written.');
      return;
    }
    const restored = await applyRevertMoveBatches(db, snapshot.entries);
    console.log(`Reverted ${restored}/${snapshot.entries.length} rows (skipped rows changed since).`);
  } finally {
    await close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }
  if (options.revertPath) return revert(options.revertPath, options.apply);
  const outPath = resolveSnapshotPath(options);

  const { db, close } = createScriptDb();
  try {
    // Soft-deleted feeds are included on purpose: `deleted_at` stops a feed
    // being handed out again, it does not move the ticks already on it, and
    // those are misfiled in exactly the same way.
    const feeds = await db
      .select({
        id: userBoards.id,
        boardType: userBoards.boardType,
        layoutId: userBoards.layoutId,
        sizeId: userBoards.sizeId,
        setIds: userBoards.setIds,
      })
      .from(userBoards)
      .where(and(eq(userBoards.ownerId, SYSTEM_BOARD_OWNER_ID), like(userBoards.slug, `${PRESENCE_SLUG_PREFIX}%`)));

    if (feeds.length === 0) {
      console.log('No per-config shared feed boards found. Nothing to do.');
      return;
    }
    const feedIds = feeds.map((feed) => Number(feed.id));
    console.log(`Found ${feeds.length} per-config shared feed boards`);

    const ticks = await loadSharedFeedTicks(db, feedIds);
    console.log(`Found ${ticks.length} ticks filed on those feeds`);

    if (ticks.length === 0) {
      console.log('Nothing to do.');
      return;
    }

    // Read candidate walls in bounded owner batches, then match in memory so the report can
    // tell "no board" apart from "two boards and no way to choose".
    const ownerIds = [...new Set(ticks.map((tick) => tick.userId))].filter(
      (ownerId) => ownerId !== SYSTEM_BOARD_OWNER_ID,
    );
    const ownedBoards = [];
    for (let offset = 0; offset < ownerIds.length; offset += BATCH_SIZE) {
      ownedBoards.push(
        ...(await db
          .select({
            id: userBoards.id,
            ownerId: userBoards.ownerId,
            boardType: userBoards.boardType,
            layoutId: userBoards.layoutId,
            sizeId: userBoards.sizeId,
            setIds: userBoards.setIds,
          })
          .from(userBoards)
          .where(
            and(inArray(userBoards.ownerId, ownerIds.slice(offset, offset + BATCH_SIZE)), isNull(userBoards.deletedAt)),
          )),
      );
    }

    const plannedFeeds = feeds.map((feed) => ({
      id: Number(feed.id),
      boardType: feed.boardType,
      layoutId: Number(feed.layoutId),
      sizeId: Number(feed.sizeId),
      setIds: feed.setIds,
    }));
    const plan = planSharedFeedTickMoves({
      feeds: plannedFeeds,
      ticks,
      ownedBoards: ownedBoards.map((board) => ({
        id: Number(board.id),
        ownerId: board.ownerId,
        boardType: board.boardType,
        layoutId: Number(board.layoutId),
        sizeId: Number(board.sizeId),
        setIds: board.setIds,
      })),
    });
    const entries: SnapshotEntry[] = plan.moves;

    console.log('');
    console.log(`Move       ${entries.length} ticks across ${plan.movedUserIds.size} climbers onto resolved walls`);
    console.log(
      `Session    ${plan.sessionMoves} moves to session walls; ${plan.sessionRetained} already correctly on the feed`,
    );
    console.log(
      `Ambiguous  ${plan.ambiguous} ticks from ${plan.ambiguousUserIds.size} climbers who own several boards of that config`,
    );
    console.log(
      `No board   ${plan.noOwnedBoard} ticks whose climber owns no board of that config (the feed is correct)`,
    );
    console.log('');

    if (entries.length === 0) {
      console.log('Nothing to do.');
      return;
    }

    const snapshot: Snapshot = { writtenAt: new Date().toISOString(), entries };

    if (!options.apply) {
      console.log(`Dry run — would re-file ${entries.length} ticks. No database writes.`);
      writeSnapshot(outPath, snapshot);
      console.log(`Planned changes written to ${outPath} (inspect before re-running with --apply).`);
      return;
    }

    // Snapshot BEFORE mutating, so an interrupted run is still revertible.
    writeSnapshot(outPath, snapshot);
    console.log(`Snapshot written to ${outPath} — revert with --revert ${outPath} --apply`);

    const updated = await applyForwardMoveBatches(db, { feeds: plannedFeeds, entries });

    console.log('');
    console.log(`Re-filed ${updated} ticks onto their resolved walls.`);
  } finally {
    await close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
