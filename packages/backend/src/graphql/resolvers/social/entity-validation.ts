import { eq, and, isNull } from 'drizzle-orm';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import type { SocialEntityType } from '@boardsesh/shared-schema';

/**
 * Validates that a target entity exists before allowing a comment or vote.
 * Performs minimal SELECT ... LIMIT 1 existence checks.
 */
export async function validateEntityExists(
  entityType: SocialEntityType,
  entityId: string,
  viewerUserId?: string,
): Promise<void> {
  switch (entityType) {
    case 'climb': {
      const [climb] = await db
        .select({
          uuid: dbSchema.boardClimbs.uuid,
          userId: dbSchema.boardClimbs.userId,
          isDraft: dbSchema.boardClimbs.isDraft,
          isListed: dbSchema.boardClimbs.isListed,
        })
        .from(dbSchema.boardClimbs)
        .where(eq(dbSchema.boardClimbs.uuid, entityId))
        .limit(1);
      if (!climb) {
        throw new Error('Climb not found');
      }
      if ((climb.isDraft === true || climb.isListed === false) && climb.userId !== viewerUserId) {
        throw new Error('Climb not found');
      }
      break;
    }

    case 'tick': {
      const [tick] = await db
        .select({ uuid: dbSchema.boardseshTicks.uuid })
        .from(dbSchema.boardseshTicks)
        .where(eq(dbSchema.boardseshTicks.uuid, entityId))
        .limit(1);
      if (!tick) {
        throw new Error('Tick not found');
      }
      break;
    }

    case 'playlist_climb': {
      // Format: "playlistUuid:climbUuid" or "playlistUuid:_all" for general playlist discussion
      const parts = entityId.split(':');
      if (parts.length !== 2) {
        throw new Error('Invalid playlist_climb entity ID format. Expected "playlistUuid:climbUuid"');
      }
      const [playlistUuid, climbUuid] = parts;

      const [playlist] = await db
        .select({ id: dbSchema.playlists.id })
        .from(dbSchema.playlists)
        .where(eq(dbSchema.playlists.uuid, playlistUuid))
        .limit(1);

      if (!playlist) {
        throw new Error('Playlist not found');
      }

      // "_all" is used for general playlist discussion — only validate playlist exists
      if (climbUuid !== '_all') {
        const [playlistClimb] = await db
          .select({ id: dbSchema.playlistClimbs.id })
          .from(dbSchema.playlistClimbs)
          .where(
            and(eq(dbSchema.playlistClimbs.playlistId, playlist.id), eq(dbSchema.playlistClimbs.climbUuid, climbUuid)),
          )
          .limit(1);

        if (!playlistClimb) {
          throw new Error('Climb not found in playlist');
        }
      }
      break;
    }

    case 'comment': {
      const [comment] = await db
        .select({ id: dbSchema.comments.id })
        .from(dbSchema.comments)
        .where(and(eq(dbSchema.comments.uuid, entityId), isNull(dbSchema.comments.deletedAt)))
        .limit(1);
      if (!comment) {
        throw new Error('Comment not found');
      }
      break;
    }

    case 'board': {
      const [board] = await db
        .select({ uuid: dbSchema.userBoards.uuid })
        .from(dbSchema.userBoards)
        .where(and(eq(dbSchema.userBoards.uuid, entityId), isNull(dbSchema.userBoards.deletedAt)))
        .limit(1);
      if (!board) {
        throw new Error('Board not found');
      }
      break;
    }

    case 'gym': {
      const [gym] = await db
        .select({ uuid: dbSchema.gyms.uuid })
        .from(dbSchema.gyms)
        .where(and(eq(dbSchema.gyms.uuid, entityId), isNull(dbSchema.gyms.deletedAt)))
        .limit(1);
      if (!gym) {
        throw new Error('Gym not found');
      }
      break;
    }

    case 'proposal': {
      const [proposal] = await db
        .select({ uuid: dbSchema.climbProposals.uuid })
        .from(dbSchema.climbProposals)
        .where(eq(dbSchema.climbProposals.uuid, entityId))
        .limit(1);
      if (!proposal) {
        throw new Error('Proposal not found');
      }
      break;
    }

    case 'session': {
      const [session] = await db
        .select({ id: dbSchema.boardSessions.id })
        .from(dbSchema.boardSessions)
        .where(eq(dbSchema.boardSessions.id, entityId))
        .limit(1);
      if (session) break;

      throw new Error('Session not found');
    }

    default: {
      throw new Error(`Unknown entity type: ${String(entityType)}`);
    }
  }
}
