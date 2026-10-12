import type { ConnectionContext, LiveSession } from '@boardsesh/shared-schema';
import { applyRateLimit, requireAuthenticated, validateInput } from '../shared/helpers';
import { FollowedLiveSessionsArgsSchema } from '../../../validation/schemas';
import {
  FOLLOWED_LIVE_SESSIONS_DEFAULT_LIMIT,
  FOLLOWED_LIVE_SESSIONS_MAX_LIMIT,
  findBoardLiveSessions,
  findFollowedLiveSessions,
} from '../../../services/live-sessions';
import { assertAnonReadableBoard, requireActiveBoardWithVisibilityById } from '../board-presence/shared';
import { assertSprayBoardIsReadable } from '../climbs/spray-read-access';
import { db } from '../../../db/client';

export const liveSessionQueries = {
  /**
   * Home's "Climbing now" rail. Signed-in only: every arm (followed climbers,
   * followed boards, the viewer's own sessions) is about the viewer.
   */
  followedLiveSessions: async (
    _: unknown,
    args: { boardUuid?: string | null; limit?: number | null },
    ctx: ConnectionContext,
  ): Promise<LiveSession[]> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 60, 'followedLiveSessions');
    const validated = validateInput(FollowedLiveSessionsArgsSchema, args, 'followedLiveSessions arguments');
    const viewerId = ctx.userId!;

    const limit = Math.min(
      Math.max(validated.limit ?? FOLLOWED_LIVE_SESSIONS_DEFAULT_LIMIT, 1),
      FOLLOWED_LIVE_SESSIONS_MAX_LIMIT,
    );
    return findFollowedLiveSessions(viewerId, { boardUuid: validated.boardUuid ?? null, limit });
  },

  /**
   * The live sessions on one board, for its presence sheet. Gated exactly like
   * `boardHistory`: an active board the viewer may read (a board they may not
   * is masked as NOT_FOUND, same as a missing one), and a spray wall's own rule
   * for everyone. The board id alone is the no-link reading, because ids can
   * be counted; an Unlisted board's sheet opens, and names its board, only for
   * a caller who also presents its uuid (`boardUuid`). Anonymous callers see
   * public sessions only and never get followed-climber reasons.
   */
  boardLiveSessions: async (
    _: unknown,
    { boardId, boardUuid }: { boardId: number; boardUuid?: string | null },
    ctx: ConnectionContext,
  ): Promise<LiveSession[]> => {
    await applyRateLimit(ctx, 60, 'boardLiveSessions');
    const visibilityBoard = await requireActiveBoardWithVisibilityById(boardId);
    await assertAnonReadableBoard(visibilityBoard, ctx.userId, boardUuid);
    await assertSprayBoardIsReadable(visibilityBoard, ctx.userId, boardUuid, db);
    return findBoardLiveSessions(boardId, ctx.userId ?? null, {
      linkHeld: typeof boardUuid === 'string' && boardUuid === visibilityBoard.uuid,
    });
  },
};
