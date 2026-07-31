import { eq } from 'drizzle-orm';
import type { BoardQueuePreview } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { pubsub } from '../pubsub';
import { isBoardAnonReadable } from '../graphql/resolvers/board-presence/shared';

/**
 * Board-queue-preview tombstone + the session-visibility (gate 2) helpers.
 *
 * Split out of `board-queue-preview.ts` deliberately: `RoomManager` calls the
 * tombstone from every session-end path, and the main preview module imports
 * `roomManager` for queue-state reads — importing the tombstone from there
 * would create a module cycle (room-manager ⇄ board-queue-preview). This
 * module must therefore never import `roomManager` (directly or transitively).
 * `board-queue-preview.ts` re-exports everything here, so other consumers can
 * keep importing from the main module.
 */

/** The `board_sessions` columns gate 2 reads. */
export type BoardSessionPreviewGate = { isPublic: boolean; status: string };

/**
 * The bound session's visibility columns, or null when the row doesn't exist.
 * Callers distinguish "active but private" (a privacy hard-stop) from
 * "ended/deleted" (a stale binding) — see
 * `resolvePublicPreviewSessionForBoard` in board-queue-preview.ts.
 */
export async function readBoardSessionPreviewGate(sessionId: string): Promise<BoardSessionPreviewGate | null> {
  const [session] = await db
    .select({ isPublic: dbSchema.boardSessions.isPublic, status: dbSchema.boardSessions.status })
    .from(dbSchema.boardSessions)
    .where(eq(dbSchema.boardSessions.id, sessionId))
    .limit(1);
  return session ?? null;
}

/** Whether this session may be previewed on public displays (gate 2). */
export async function isPublicActiveSession(sessionId: string): Promise<boolean> {
  const session = await readBoardSessionPreviewGate(sessionId);
  return Boolean(session && session.isPublic && session.status === 'active');
}

/**
 * An empty preview snapshot — the tombstone published when a board's bound
 * session stops being publicly previewable (ended, or a future `is_public`
 * flip), so kiosks clear instead of showing the last queue forever.
 */
export function buildEmptyBoardQueuePreview(boardId: number): BoardQueuePreview {
  return {
    boardId,
    current: null,
    upNext: [],
    queueLength: 0,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Publish an EMPTY preview (tombstone) for the board this session is bound
 * to, clearing kiosks when the session stops being publicly previewable. The
 * live producer re-gates every queue-event publish, but a session ending (or
 * a visibility flip) is not a queue event — without this, the last published
 * snapshot would sit on public displays indefinitely.
 *
 * Called from every session-end path (`RoomManager.endSession` behind the
 * explicit `endSession` mutation, and the inactivity sweep). There is
 * currently no mutation that flips `board_sessions.is_public` after creation
 * — if one is ever added, it MUST call this too when flipping to private.
 * The board-level equivalent (`user_boards.is_public` flipped private, or the
 * board soft-deleted) goes through `publishBoardQueuePreviewTombstoneForBoard`
 * below, which `updateBoard`/`deleteBoard` call.
 *
 * Guards, in order:
 * - Only while the board's REVERSE binding still points at THIS session. When
 *   a different session has since taken the wall, its queue owns the preview
 *   — an old session's end must not clobber it.
 * - Only for anon-readable boards (gate 1) — the producer never published for
 *   other boards, so there is nothing to clear, and an empty publish would
 *   still leak "a session just ended here" timing on a private board's
 *   channel.
 * - Only when the session genuinely is no longer previewable
 *   (`isPublicActiveSession` false) — a misplaced call for a still-live
 *   public session must not blank kiosks until the next queue event.
 *
 * Publisher-instance-only like every other preview publish: the end paths run
 * on one instance and the board-queue channel Redis-fans-out the tombstone to
 * every instance's subscribers.
 */
export async function publishBoardQueuePreviewTombstoneForSession(sessionId: string): Promise<void> {
  const boardId = await pubsub.getSessionBoard(sessionId);
  if (!boardId) return;

  const boundSessionId = await pubsub.getBoardSession(boardId);
  if (boundSessionId !== sessionId) return;

  if (!(await isBoardAnonReadable(Number(boardId)))) return;
  if (await isPublicActiveSession(sessionId)) return;

  pubsub.publishBoardQueuePreview(boardId, buildEmptyBoardQueuePreview(Number(boardId)));
}

/**
 * Publish an EMPTY preview (tombstone) for a board that just STOPPED being
 * anonymously readable — `user_boards.is_public` flipped true→false, or the
 * board was soft-deleted. Without this, kiosks keep rendering the last
 * snapshot forever: the live producer re-gates every queue event, but a
 * board-visibility flip is not a queue event, and once the flip commits the
 * producer simply goes quiet.
 *
 * Only publishes when the board still has a bound session (the only case where
 * a snapshot was ever produced, so the only case where anything needs
 * clearing).
 *
 * Deliberately does NOT re-check `isBoardAnonReadable` or
 * `isPublicActiveSession` the way `...ForSession` does: by the time a caller
 * gets here the board is already private/deleted, so both gates would return
 * false and suppress the exact publish this function exists to make.
 *
 * **The caller owns the privacy gate.** Call this ONLY on a genuine
 * anon-readable → not-anon-readable transition, using the pre-update row it
 * already has in hand (no extra query needed). Publishing on a board that was
 * never anon-readable would leak "something just changed here" on a private
 * board's channel to anyone who guessed its id — the same leak
 * `...ForSession`'s gate 1 exists to prevent.
 */
export async function publishBoardQueuePreviewTombstoneForBoard(boardId: number): Promise<void> {
  const boundSessionId = await pubsub.getBoardSession(String(boardId));
  if (!boundSessionId) return;

  pubsub.publishBoardQueuePreview(String(boardId), buildEmptyBoardQueuePreview(boardId));
}
