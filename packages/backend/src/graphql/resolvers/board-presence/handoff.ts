import { v4 as uuidv4 } from 'uuid';
import { eq } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import type { BoardHandoffRequester, BoardPresenceEvent, ConnectionContext } from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import { pubsub } from '../../../pubsub/index';
import { roomManager } from '../../../services/room-manager';
import { applyRateLimit, requireAuthenticated } from '../shared/helpers';
import { assertValidBoardId } from './shared';

/**
 * Hand-off requests per user per minute. A swipe is a deliberate gesture and the
 * requester's phone waits 12 s for each answer, so a climber asks a handful of
 * times a minute at most; anything above this is a loop or abuse, and every
 * request disconnects someone else's Bluetooth link.
 */
export const BOARD_HANDOFF_RATE_LIMIT_PER_MINUTE = 10;

function forbidden(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: 'FORBIDDEN' } });
}

async function loadRequester(userId: string): Promise<BoardHandoffRequester> {
  const [row] = await db
    .select({
      name: dbSchema.users.name,
      image: dbSchema.users.image,
      displayName: dbSchema.userProfiles.displayName,
      avatarUrl: dbSchema.userProfiles.avatarUrl,
    })
    .from(dbSchema.users)
    .leftJoin(dbSchema.userProfiles, eq(dbSchema.users.id, dbSchema.userProfiles.userId))
    .where(eq(dbSchema.users.id, userId))
    .limit(1);
  return {
    userId,
    // The same identity `reportBoardClimb` puts on a holder: the profile name,
    // then the account's.
    displayName: row?.displayName ?? row?.name ?? null,
    avatarUrl: row?.avatarUrl ?? row?.image ?? null,
  };
}

/**
 * Whether a board-presence event goes to this subscriber. Every event does, but
 * a `BoardHandoffRequested`, which only the holder it names (signed in as that
 * account) receives.
 */
export function isForThisViewer(event: BoardPresenceEvent, viewerUserId: string | null | undefined): boolean {
  if (event.__typename !== 'BoardHandoffRequested') return true;
  return viewerUserId != null && event.holderUserId === viewerUserId;
}

export const boardHandoffMutations = {
  /**
   * Take a crewmate's board (#7113): ask the phone that holds the board's
   * Bluetooth link to let go, so the caller can connect. Aurora and MoonBoard
   * boxes stop advertising once linked (Android also refuses a second phone), so
   * a plain connect from the caller can't take it; the holder's phone has to let
   * go first.
   *
   * Auth-required, unlike `reportBoardClimb`: the request disconnects another
   * person's link, so it needs an accountable identity, and the holder's phone
   * names who took the board. The client only offers it to a signed-in climber.
   *
   * Gates, in order: the rate limit, board membership (the same proof of
   * presence `reportBoardClimb` asks for), and that the holder is a signed-in
   * member of the caller's party session. A stranger who shares the board feed
   * can't kick anyone off.
   *
   * Publishes `BoardHandoffRequested` on the board's presence channel;
   * `boardNowPlaying` delivers it only to subscribers signed in as the holder.
   * It takes no board seq: everyone else would read the filtered number as a
   * missed event. Nothing else changes here; the holder's `reportBoardDisconnect`
   * frees the board, and the caller connects once it sees that.
   *
   * Returns false when there is nobody to ask: the board is free, or the caller
   * already holds it.
   */
  requestBoardHandoff: async (
    _: unknown,
    { boardId }: { boardId: number },
    ctx: ConnectionContext,
  ): Promise<boolean> => {
    requireAuthenticated(ctx);
    const requesterUserId = ctx.userId;
    if (!requesterUserId) throw forbidden('Sign in to take the board');
    await applyRateLimit(ctx, BOARD_HANDOFF_RATE_LIMIT_PER_MINUTE, 'requestBoardHandoff');
    assertValidBoardId(boardId);
    const boardKey = String(boardId);

    const gate = await pubsub.getBoardReportGate(boardKey, requesterUserId);
    if (!gate.isMember) throw forbidden('Not connected to this board');
    const holderUserId = gate.currentWriter;
    if (holderUserId === null || holderUserId === requesterUserId) return false;
    // An anonymous holder (`conn:{connectionId}`) can't be addressed, and can't
    // be in a session roster by account.
    if (holderUserId.startsWith('conn:')) throw forbidden('The board is held outside your session');

    const sessionId = roomManager.getClient(ctx.connectionId)?.sessionId ?? null;
    if (!sessionId) throw forbidden('Join the session to take the board');
    const members = await roomManager.getSessionUsers(sessionId);
    if (!members.some((member) => member.userId === holderUserId)) {
      throw forbidden('The board is held outside your session');
    }

    const requester = await loadRequester(requesterUserId);
    pubsub.publishBoardPresenceEvent(boardKey, {
      __typename: 'BoardHandoffRequested',
      holderUserId,
      requester,
      requestId: uuidv4(),
      requestedAt: new Date().toISOString(),
    });
    return true;
  },
};
