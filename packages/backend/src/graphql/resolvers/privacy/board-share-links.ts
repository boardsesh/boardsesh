import type { ConnectionContext } from '@boardsesh/shared-schema';
import { z } from 'zod';
import { logger } from '../../../utils/logger';
import { applyRateLimit, requireAuthenticated, validateInput } from '../shared/helpers';
import { privacyControlsEnabled, requirePrivacyControls } from '../../../services/privacy';
import {
  getOrCreateBoardShareLink,
  previewBoardShareLink,
  redeemBoardShareLink,
  resetBoardShareLink,
} from '../../../services/board-share-links';

/**
 * A home board's share link. The rules live in `services/board-share-links.ts`.
 *
 * None of these publishes `privacyChanged`. A join only adds access, the
 * joiner's own app refreshes after its own mutation, and the server checks
 * access on every read, so no other client has anything to drop.
 *
 * The token is an argument here and nowhere else: none of these resolvers logs
 * it, and the errors they throw never carry it.
 */

const boardUuidSchema = z.string().min(1).max(128);

function viewer(ctx: ConnectionContext): string {
  requireAuthenticated(ctx);
  return ctx.userId!;
}

export const boardShareLinkQueries = {
  boardShareLink: async (_: unknown, { boardUuid }: { boardUuid: string }, ctx: ConnectionContext) => {
    const ownerId = viewer(ctx);
    requirePrivacyControls();
    await applyRateLimit(ctx, 60, 'boardShareLink');
    return getOrCreateBoardShareLink(validateInput(boardUuidSchema, boardUuid, 'boardUuid'), ownerId);
  },
  /**
   * Anonymous: the signed-out web page names the board before asking for a
   * sign-in. The ceiling is high on purpose: www makes this call from its own
   * server, so every signed-out visitor and link unfurler shares its one IP
   * bucket, and a 128-bit token cannot be enumerated anyway. It only stops a
   * runaway loop.
   */
  boardShareLinkPreview: async (_: unknown, { token }: { token: string }, ctx: ConnectionContext) => {
    await applyRateLimit(ctx, 600, 'boardShareLinkPreview');
    if (!privacyControlsEnabled()) return null;
    return previewBoardShareLink(token);
  },
};

export const boardShareLinkMutations = {
  resetBoardShareLink: async (_: unknown, { boardUuid }: { boardUuid: string }, ctx: ConnectionContext) => {
    const ownerId = viewer(ctx);
    requirePrivacyControls();
    await applyRateLimit(ctx, 30, 'privacyMutation');
    return resetBoardShareLink(validateInput(boardUuidSchema, boardUuid, 'boardUuid'), ownerId);
  },
  redeemBoardShareLink: async (_: unknown, { token }: { token: string }, ctx: ConnectionContext) => {
    const userId = viewer(ctx);
    requirePrivacyControls();
    await applyRateLimit(ctx, 30, 'privacyMutation');
    const redemption = await redeemBoardShareLink(token, userId);
    if (redemption.granted) {
      // Same preview refresh as an owner's name invite. The grant is committed,
      // so a failed kiosk republish must not turn the join into an error.
      try {
        const { notifyResourcePrivacyChanged } = await import('../../../services/board-session-privacy');
        await notifyResourcePrivacyChanged('board', redemption.boardUuid);
      } catch (error) {
        logger.warn('[BoardShareLink] board preview republish failed after a link join', { error });
      }
    }
    return { boardUuid: redemption.boardUuid, slug: redemption.slug };
  },
};
