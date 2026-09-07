/**
 * Re-file ticks that landed on a per-config SHARED FEED board onto the wall
 * their climber actually owns.
 *
 * Resolves the data half of #5121. The code path was fixed in the same issue's
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
 * The rule, deliberately narrow: a tick moves only when its climber owns
 * EXACTLY ONE non-deleted board with the same (board_type, layout_id, size_id,
 * normalised set_ids). Two same-config boards is the #4174 "same wall at home
 * and at the gym" case, and nothing in the row says which one the climber was
 * standing at — those are counted and left alone. So are ticks from climbers
 * who own no matching board: the shared feed is where those belong, and the
 * fixed code still files them there.
 *
 * Set ids are compared normalised, not as raw strings. `createBoard` stores
 * whatever order it was handed, so a board saved as '25,26,27,24' is the same
 * wall as a feed keyed '24,25,26,27'.
 *
 * Approved by maintainer 2026-09-07.
 *
 * Usage (needs a DB_URL with UPDATE rights — the usual read-only credential can
 * run --dry-run but not the apply step):
 *   vp run db:backfill-shared-feed-tick-boards -- --dry-run
 *   vp run db:backfill-shared-feed-tick-boards
 *   vp run db:backfill-shared-feed-tick-boards -- --revert <snapshot.json>
 *
 * Options:
 *   --dry-run        Match and report, write nothing. Still writes the plan file.
 *   --revert <file>  Restore board ids from a snapshot written by a prior run.
 *   --out <file>     Snapshot path (default ./shared-feed-tick-boards-<date>.json).
 *
 * Safe to re-run: a tick already moved off the feed stops matching.
 */

import { readFileSync, writeFileSync } from 'fs';
import { and, eq, inArray, isNull, like } from 'drizzle-orm';
import { createScriptDb } from './db-connection.js';
import { planSharedFeedTickMoves } from './backfill-shared-feed-tick-boards-helpers.js';
import { boardseshTicks } from '../src/schema/app/ascents.js';
import { userBoards } from '../src/schema/app/boards.js';

// Mirrors the backend's `SYSTEM_BOARD_OWNER_ID` and
// `BOARD_CONFIG_PRESENCE_SLUG_PREFIX` (graphql/resolvers/board-presence/shared.ts).
// Duplicated rather than imported: packages/db must not depend on the backend.
// Identity is owner + slug namespace, never the display name — the ~520 seeded
// catalog boards are system-owned too and name real walls.
const SYSTEM_BOARD_OWNER_ID = '00000000-0000-0000-0000-000000000000';
const PRESENCE_SLUG_PREFIX = 'presence-';

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

const revertPath = flag('--revert');
const dryRun = args.includes('--dry-run');
const outPath = flag('--out') ?? `./shared-feed-tick-boards-${new Date().toISOString().slice(0, 10)}.json`;

type SnapshotEntry = { uuid: string; oldBoardId: number; newBoardId: number };
type Snapshot = { writtenAt: string; entries: SnapshotEntry[] };

async function revert(snapshotPath: string) {
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as Snapshot;
  const { db, close } = createScriptDb();
  try {
    console.log(`Reverting ${snapshot.entries.length} rows from ${snapshotPath} (written ${snapshot.writtenAt})`);
    if (dryRun) {
      console.log('Dry run — nothing written.');
      return;
    }
    // Atomic, same reasoning as the forward pass: a half-reverted logbook is
    // the one state with no clean recovery path.
    const restored = await db.transaction(async (txn) => {
      let applied = 0;
      for (const entry of snapshot.entries) {
        // Only revert rows still holding the board we wrote, so a later change
        // — the climber re-filing the tick, a board merge — is never clobbered.
        const rows = await txn
          .update(boardseshTicks)
          .set({ boardId: entry.oldBoardId, updatedAt: new Date().toISOString() })
          .where(and(eq(boardseshTicks.uuid, entry.uuid), eq(boardseshTicks.boardId, entry.newBoardId)))
          .returning({ uuid: boardseshTicks.uuid });
        applied += rows.length;
      }
      return applied;
    });
    console.log(`Reverted ${restored}/${snapshot.entries.length} rows (skipped rows changed since).`);
  } finally {
    await close();
  }
}

async function main() {
  if (revertPath) return revert(revertPath);

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

    const ticks = await db
      .select({ uuid: boardseshTicks.uuid, userId: boardseshTicks.userId, boardId: boardseshTicks.boardId })
      .from(boardseshTicks)
      .where(inArray(boardseshTicks.boardId, feedIds));
    console.log(`Found ${ticks.length} ticks filed on those feeds`);

    if (ticks.length === 0) {
      console.log('Nothing to do.');
      return;
    }

    // Every candidate wall in one read, matched in memory so the report can
    // tell "no board" apart from "two boards and no way to choose".
    const ownerIds = [...new Set(ticks.map((tick) => tick.userId))];
    const ownedBoards = await db
      .select({
        id: userBoards.id,
        ownerId: userBoards.ownerId,
        boardType: userBoards.boardType,
        layoutId: userBoards.layoutId,
        sizeId: userBoards.sizeId,
        setIds: userBoards.setIds,
      })
      .from(userBoards)
      .where(and(inArray(userBoards.ownerId, ownerIds), isNull(userBoards.deletedAt)));

    const plan = planSharedFeedTickMoves({
      feeds: feeds.map((feed) => ({
        id: Number(feed.id),
        boardType: feed.boardType,
        layoutId: Number(feed.layoutId),
        sizeId: Number(feed.sizeId),
        setIds: feed.setIds,
      })),
      ticks: ticks.map((tick) => ({ uuid: tick.uuid, userId: tick.userId, boardId: Number(tick.boardId) })),
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
    console.log(`Move       ${entries.length} ticks across ${plan.movedUserIds.size} climbers onto their own board`);
    console.log(
      `Ambiguous  ${plan.ambiguous} ticks from ${plan.ambiguousUserIds.size} climbers who own several boards of that config`,
    );
    console.log(`No board   ${plan.noOwnedBoard} ticks whose climber owns no board of that config (the feed is correct)`);
    console.log('');

    if (entries.length === 0) {
      console.log('Nothing to do.');
      return;
    }

    const snapshot: Snapshot = { writtenAt: new Date().toISOString(), entries };

    if (dryRun) {
      console.log(`Dry run — would re-file ${entries.length} ticks. Nothing written.`);
      writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
      console.log(`Planned changes written to ${outPath} (inspect before re-running without --dry-run).`);
      return;
    }

    // Snapshot BEFORE mutating, so an interrupted run is still revertible.
    writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
    console.log(`Snapshot written to ${outPath} — revert with --revert ${outPath}`);

    // Grouped by destination so each batch is one UPDATE, and guarded on the
    // feed id the plan was built against: a tick re-filed by the fixed code
    // between the read and the write keeps its newer board.
    const byDestination = new Map<string, string[]>();
    for (const entry of entries) {
      const key = `${entry.oldBoardId}|${entry.newBoardId}`;
      const bucket = byDestination.get(key);
      if (bucket) bucket.push(entry.uuid);
      else byDestination.set(key, [entry.uuid]);
    }

    const batchSize = 500;
    // One transaction across every batch. Batching keeps each statement's
    // parameter list sane, but a run interrupted between batches would leave
    // the repair half-applied — recoverable from the snapshot, but only if the
    // operator still has it. All-or-nothing is cheap at this size.
    const updated = await db.transaction(async (txn) => {
      let applied = 0;
      for (const [key, uuids] of byDestination) {
        const [oldBoardId, newBoardId] = key.split('|').map(Number);
        for (let offset = 0; offset < uuids.length; offset += batchSize) {
          const batch = uuids.slice(offset, offset + batchSize);
          const rows = await txn
            .update(boardseshTicks)
            .set({ boardId: newBoardId, updatedAt: new Date().toISOString() })
            .where(and(inArray(boardseshTicks.uuid, batch), eq(boardseshTicks.boardId, oldBoardId)))
            .returning({ uuid: boardseshTicks.uuid });
          applied += rows.length;
        }
      }
      return applied;
    });

    console.log('');
    console.log(`Re-filed ${updated} ticks onto their climber's own board.`);
  } finally {
    await close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
