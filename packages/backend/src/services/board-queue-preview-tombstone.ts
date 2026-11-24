import { canAccessResourceWithoutLink } from './privacy';
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import type { BoardQueuePreview } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { pubsub } from '../pubsub';
import { isBoardAnonReadable, followBoardMergeChain } from '../graphql/resolvers/board-presence/shared';

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
  return session
    ? // A kiosk is a public listing: an unlisted session's link never reaches it.
      { ...session, isPublic: session.isPublic && (await canAccessResourceWithoutLink('session', sessionId, null)) }
    : null;
}

/** Whether this session may be previewed on public displays (gate 2). */
export async function isPublicActiveSession(sessionId: string): Promise<boolean> {
  const session = await readBoardSessionPreviewGate(sessionId);
  return Boolean(session && session.isPublic && session.status === 'active');
}

/**
 * An empty preview snapshot — the tombstone published when a board's bound
 * session stops being publicly previewable (ended, or an `is_public`
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

/** Public-only admin merges attest which former identities may retain a live preview binding.
 * Old CLI merges carry no such privacy proof. Only direct, recent attestations
 * on the current canonical row qualify; a later merge chain fails closed.
 */
export async function readAttestedMergedPreviewSources(canonicalBoardId: number) {
  const [canonical] = await db
    .select({ uuid: dbSchema.userBoards.uuid })
    .from(dbSchema.userBoards)
    .where(eq(dbSchema.userBoards.id, canonicalBoardId))
    .limit(1);
  if (!canonical) return [];
  const events = await db
    .select({ details: dbSchema.boardModerationEvents.details })
    .from(dbSchema.boardModerationEvents)
    .where(
      and(
        eq(dbSchema.boardModerationEvents.boardId, canonicalBoardId),
        eq(dbSchema.boardModerationEvents.action, 'edited_by_staff'),
      ),
    )
    .orderBy(desc(dbSchema.boardModerationEvents.id))
    .limit(100);
  const sourceUuids = [
    ...new Set(
      events.flatMap(({ details }) =>
        details?.mutation === 'mergeDuplicateBoards' && details.merge?.canonicalBoardUuid === canonical.uuid
          ? details.merge.duplicateBoardUuids
          : [],
      ),
    ),
  ];
  if (!sourceUuids.length || sourceUuids.length > 100) return [];
  const sources = await db
    .select({
      id: dbSchema.userBoards.id,
      uuid: dbSchema.userBoards.uuid,
      ownerId: dbSchema.userBoards.ownerId,
      policy: dbSchema.resourcePrivacy,
    })
    .from(dbSchema.userBoards)
    .leftJoin(
      dbSchema.resourcePrivacy,
      and(
        eq(dbSchema.resourcePrivacy.kind, 'board'),
        eq(dbSchema.resourcePrivacy.resourceId, dbSchema.userBoards.uuid),
      ),
    )
    .where(
      and(
        eq(dbSchema.userBoards.isUnlisted, false),
        inArray(dbSchema.userBoards.uuid, sourceUuids),
        isNotNull(dbSchema.userBoards.deletedAt),
        eq(dbSchema.userBoards.mergedIntoBoardUuid, canonical.uuid),
      ),
    );
  return sources
    .filter(
      ({ ownerId, policy }) =>
        !policy ||
        (policy.ownerId === ownerId &&
          policy.audience === 'public' &&
          policy.locationAudience === 'public' &&
          !policy.inheritFollowers),
    )
    .map(({ id, uuid }) => ({ id, uuid }));
}

/** Only explicit board merges may redirect a stale preview binding. Ordinary deletes stay silent. */
export async function resolveMergedSessionPreviewBoardId(
  sessionId: string,
  originalBoardId: number,
): Promise<number | null> {
  const [original] = await db
    .select({ deletedAt: dbSchema.userBoards.deletedAt, mergedIntoBoardUuid: dbSchema.userBoards.mergedIntoBoardUuid })
    .from(dbSchema.userBoards)
    .where(eq(dbSchema.userBoards.id, originalBoardId))
    .limit(1);
  if (!original?.deletedAt || !original.mergedIntoBoardUuid) return null;
  const canonical = await followBoardMergeChain(original.mergedIntoBoardUuid);
  if (!canonical || canonical.id === originalBoardId) return null;
  const [session] = await db
    .select({ boardId: dbSchema.boardSessions.boardId })
    .from(dbSchema.boardSessions)
    .where(eq(dbSchema.boardSessions.id, sessionId))
    .limit(1);
  if (!session || (session.boardId !== null && session.boardId !== canonical.id)) return null;
  const sources = await readAttestedMergedPreviewSources(canonical.id);
  return sources.some((source) => source.id === originalBoardId) ? canonical.id : null;
}

/**
 * Publish an EMPTY preview (tombstone) for the board this session is bound
 * to, clearing kiosks when the session stops being publicly previewable. The
 * live producer re-gates every queue-event publish, but a session ending (or
 * a visibility flip) is not a queue event — without this, the last published
 * snapshot would sit on public displays indefinitely.
 *
 * Called from every session-end path (`RoomManager.endSession` behind the
 * explicit `endSession` mutation, and the inactivity sweep). A writer of
 * `board_sessions.is_public` needs more than this, because a kiosk can also
 * show a session through the durable `board_id` fallback, which this function
 * does not look at: `updateSession` calls `republishBoardQueuePreviewsForSession`
 * (board-queue-preview.ts), and any other writer of that column MUST too.
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

  if (!(await isBoardAnonReadable(Number(boardId)))) {
    const canonicalBoardId = await resolveMergedSessionPreviewBoardId(sessionId, Number(boardId));
    if (canonicalBoardId === null || (await isPublicActiveSession(sessionId))) return;
    // Loaded only after a merge, keeping the RoomManager/tombstone import graph acyclic.
    const { republishBoardQueuePreviewForBoard } = await import('./board-queue-preview');
    await republishBoardQueuePreviewForBoard(canonicalBoardId);
    return;
  }
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
 * Publishes UNCONDITIONALLY once the caller's transition gate holds. It
 * deliberately does not require a live `board:{id}:session` binding first:
 * that binding is only a side effect of a climb report, TTLs out after 12h,
 * and is process-local when Redis is off — while the snapshot a kiosk is
 * actually rendering can equally come from
 * `resolvePublicPreviewSessionForBoard`'s durable fallback (newest active
 * public `board_sessions` row for the board). Gating on the binding would
 * leave exactly those kiosks — no send in 12h, Redis flushed, or a Redis-less
 * restart — stuck on the stale queue forever, which is the bug this exists to
 * fix. An empty publish on a channel nobody watches costs one PUBLISH.
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
  pubsub.publishBoardQueuePreview(String(boardId), buildEmptyBoardQueuePreview(boardId));
}
