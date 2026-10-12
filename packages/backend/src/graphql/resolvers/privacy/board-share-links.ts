import type { ConnectionContext } from '@boardsesh/shared-schema';
import { z } from 'zod';
import { pubsub } from '../../../pubsub';
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
 * Mounted beside, not inside, `notifyingPrivacyMutations`: that wrapper
 * publishes `privacyChanged` after every call, and that event makes every
 * signed-in client clear its protected caches and refetch. A redemption
 * publishes it once, and only when it actually granted access; a repeat
 * redemption and a reset change nobody's access, so they publish nothing.
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
      // Same follow-up as an owner's name invite. The grant is committed, so a
      // failed kiosk republish must not turn the join into an error.
      try {
        const { notifyResourcePrivacyChanged } = await import('../../../services/board-session-privacy');
        await notifyResourcePrivacyChanged('board', redemption.boardUuid);
      } catch (error) {
        logger.warn('[BoardShareLink] board preview republish failed after a link join', { error });
      }
      pubsub.publishPrivacyChanged();
    }
    return { boardUuid: redemption.boardUuid, slug: redemption.slug };
  },
};
