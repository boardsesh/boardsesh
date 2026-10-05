import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { SocialEntityType } from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import { sprayReferenceClimbExistsCondition, sprayReferenceVisibilityCondition } from '@boardsesh/db/queries';
import { dbRead } from '../../../db/client';

/** Known spray references must have a live, readable climb. One query for a batch. */
export async function readableSprayClimbUuids(
  climbUuids: string[],
  viewerUserId: string | null | undefined,
): Promise<Set<string>> {
  if (climbUuids.length === 0) return new Set();
  const climbs = await dbRead
    .select({ uuid: dbSchema.boardClimbs.uuid })
    .from(dbSchema.boardClimbs)
    .where(
      and(
        inArray(dbSchema.boardClimbs.uuid, climbUuids),
        eq(dbSchema.boardClimbs.boardType, 'spray'),
        sprayReferenceVisibilityCondition(
          { boardType: dbSchema.boardClimbs.boardType, climbUuid: dbSchema.boardClimbs.uuid },
          viewerUserId,
        ),
      ),
    );
  return new Set(climbs.map((climb) => climb.uuid));
}

/**
 * Resolve social references in batches, before reading thread prose or vote totals.
 * A missing spray climb is readable only through its author's retained tick.
 * Comments and playlist discussions carry their root entity, rather than granting
 * access just because their UUID was once shared. Bound malformed comment chains.
 */
export async function readableSocialEntityIds(
  entityType: SocialEntityType,
  entityIds: string[],
  viewerUserId: string | null | undefined,
  depth = 0,
): Promise<Set<string>> {
  if (entityIds.length === 0 || depth >= 8) return new Set();
  switch (entityType) {
    case 'climb': {
      // Threads do not retain board type after deletion. Product policy hides
      // all missing-climb threads, including catalogue archives, for privacy.
      const climbs = await dbRead
        .select({ uuid: dbSchema.boardClimbs.uuid })
        .from(dbSchema.boardClimbs)
        .where(
          and(
            inArray(dbSchema.boardClimbs.uuid, entityIds),
            sprayReferenceVisibilityCondition(
              { boardType: dbSchema.boardClimbs.boardType, climbUuid: dbSchema.boardClimbs.uuid },
              viewerUserId,
            ),
          ),
        );
      return new Set(climbs.map((climb) => climb.uuid));
    }
    case 'tick': {
      const ticks = await dbRead
        .select({ uuid: dbSchema.boardseshTicks.uuid })
        .from(dbSchema.boardseshTicks)
        .where(
          and(
            inArray(dbSchema.boardseshTicks.uuid, entityIds),
            sprayReferenceVisibilityCondition(
              { boardType: dbSchema.boardseshTicks.boardType, climbUuid: dbSchema.boardseshTicks.climbUuid },
              viewerUserId,
            ),
            sprayReferenceClimbExistsCondition(
              { boardType: dbSchema.boardseshTicks.boardType, climbUuid: dbSchema.boardseshTicks.climbUuid },
              { authorId: dbSchema.boardseshTicks.userId, viewerUserId },
            ),
          ),
        );
      return new Set(ticks.map((tick) => tick.uuid));
    }
    case 'proposal': {
      const proposals = await dbRead
        .select({ uuid: dbSchema.climbProposals.uuid })
        .from(dbSchema.climbProposals)
        .where(
          and(
            inArray(dbSchema.climbProposals.uuid, entityIds),
            sprayReferenceVisibilityCondition(
              { boardType: dbSchema.climbProposals.boardType, climbUuid: dbSchema.climbProposals.climbUuid },
              viewerUserId,
            ),
            sprayReferenceClimbExistsCondition({
              boardType: dbSchema.climbProposals.boardType,
              climbUuid: dbSchema.climbProposals.climbUuid,
            }),
          ),
        );
      return new Set(proposals.map((proposal) => proposal.uuid));
    }
    case 'comment': {
      const comments = await dbRead
        .select({
          uuid: dbSchema.comments.uuid,
          entityType: dbSchema.comments.entityType,
          entityId: dbSchema.comments.entityId,
        })
        .from(dbSchema.comments)
        .where(and(inArray(dbSchema.comments.uuid, entityIds), isNull(dbSchema.comments.deletedAt)));
      const rootIdsByType = new Map<SocialEntityType, string[]>();
      for (const comment of comments) {
        const rootIds = rootIdsByType.get(comment.entityType) ?? [];
        rootIds.push(comment.entityId);
        rootIdsByType.set(comment.entityType, rootIds);
      }
      const readableRoots = new Map<SocialEntityType, Set<string>>();
      for (const [rootType, rootIds] of rootIdsByType) {
        readableRoots.set(
          rootType,
          await readableSocialEntityIds(rootType, [...new Set(rootIds)], viewerUserId, depth + 1),
        );
      }
      return new Set(
        comments
          .filter((comment) => readableRoots.get(comment.entityType)?.has(comment.entityId))
          .map((comment) => comment.uuid),
      );
    }
    case 'playlist_climb': {
      const discussionClimbs = new Map<string, string>();
      const readableIds = new Set<string>();
      for (const entityId of entityIds) {
        const [playlistUuid, climbUuid, extra] = entityId.split(':');
        if (!playlistUuid || !climbUuid || extra !== undefined) continue;
        if (climbUuid === '_all') readableIds.add(entityId);
        else discussionClimbs.set(entityId, climbUuid);
      }
      const readableClimbs = await readableSocialEntityIds(
        'climb',
        [...new Set(discussionClimbs.values())],
        viewerUserId,
        depth + 1,
      );
      for (const [entityId, climbUuid] of discussionClimbs) {
        if (readableClimbs.has(climbUuid)) readableIds.add(entityId);
      }
      return readableIds;
    }
    default:
      return new Set(entityIds);
  }
}
