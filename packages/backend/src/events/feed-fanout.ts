import type { SocialEvent } from '@boardsesh/shared-schema';
import type { SocialEntityType } from '@boardsesh/db/schema';
import { db } from '../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { and, eq, or } from 'drizzle-orm';
import { buildFeedItemMetadata } from './feed-metadata';
import { isNoMatchClimb } from '../graphql/resolvers/shared/helpers';

export { buildFeedItemMetadata } from './feed-metadata';

const FANOUT_BATCH_SIZE = 1000;
const COMMENT_PREVIEW_LENGTH = 180;

type FeedInsertRow = typeof dbSchema.feedItems.$inferInsert & {
  recipientId: string;
  type: dbSchema.FeedItemType;
  entityType: SocialEntityType;
  entityId: string;
};

function feedRowIdentityKey(row: Pick<FeedInsertRow, 'recipientId' | 'type' | 'entityType' | 'entityId'>): string {
  return JSON.stringify([row.recipientId, row.type, row.entityType, row.entityId]);
}

async function insertFeedRows(rows: FeedInsertRow[]): Promise<void> {
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += FANOUT_BATCH_SIZE) {
    const batchByIdentity = new Map<string, FeedInsertRow>();
    for (const row of rows.slice(rowIndex, rowIndex + FANOUT_BATCH_SIZE)) {
      batchByIdentity.set(feedRowIdentityKey(row), row);
    }

    const batch = [...batchByIdentity.values()];
    if (batch.length === 0) continue;

    const existingRows = await db
      .select({
        recipientId: dbSchema.feedItems.recipientId,
        type: dbSchema.feedItems.type,
        entityType: dbSchema.feedItems.entityType,
        entityId: dbSchema.feedItems.entityId,
      })
      .from(dbSchema.feedItems)
      .where(
        or(
          ...batch.map((row) =>
            and(
              eq(dbSchema.feedItems.recipientId, row.recipientId),
              eq(dbSchema.feedItems.type, row.type),
              eq(dbSchema.feedItems.entityType, row.entityType),
              eq(dbSchema.feedItems.entityId, row.entityId),
            ),
          ),
        ),
      );

    const existingKeys = new Set(existingRows.map(feedRowIdentityKey));
    const insertRows = batch.filter((row) => !existingKeys.has(feedRowIdentityKey(row)));
    if (insertRows.length > 0) await db.insert(dbSchema.feedItems).values(insertRows);
  }
}

async function getUserFollowerIds(userId: string): Promise<string[]> {
  const followers = await db
    .select({ followerId: dbSchema.userFollows.followerId })
    .from(dbSchema.userFollows)
    .where(eq(dbSchema.userFollows.followingId, userId));

  return followers.map((follow) => follow.followerId);
}

async function getSetterFollowerIds(setterUsername: string | null | undefined): Promise<string[]> {
  const normalizedSetterUsername = setterUsername?.trim();
  if (!normalizedSetterUsername) return [];

  const followers = await db
    .select({ followerId: dbSchema.setterFollows.followerId })
    .from(dbSchema.setterFollows)
    .where(eq(dbSchema.setterFollows.setterUsername, normalizedSetterUsername));

  return followers.map((follow) => follow.followerId);
}

function uniqueRecipientIds(recipientIds: string[], actorId: string): string[] {
  const seenRecipientIds = new Set<string>();
  const dedupedRecipientIds: string[] = [];

  for (const recipientId of recipientIds) {
    if (recipientId === actorId || seenRecipientIds.has(recipientId)) continue;
    seenRecipientIds.add(recipientId);
    dedupedRecipientIds.push(recipientId);
  }

  return dedupedRecipientIds;
}

async function getActorMetadata(actorId: string): Promise<Record<string, unknown>> {
  const [actor] = await db
    .select({
      name: dbSchema.users.name,
      image: dbSchema.users.image,
      displayName: dbSchema.userProfiles.displayName,
      avatarUrl: dbSchema.userProfiles.avatarUrl,
    })
    .from(dbSchema.users)
    .leftJoin(dbSchema.userProfiles, eq(dbSchema.users.id, dbSchema.userProfiles.userId))
    .where(eq(dbSchema.users.id, actorId))
    .limit(1);

  return {
    actorDisplayName: actor?.displayName || actor?.name || null,
    actorAvatarUrl: actor?.avatarUrl || actor?.image || null,
  };
}

function truncateCommentBody(body: string): string {
  return body.length > COMMENT_PREVIEW_LENGTH ? `${body.slice(0, COMMENT_PREVIEW_LENGTH)}...` : body;
}

async function buildNewClimbMetadata(event: SocialEvent): Promise<Record<string, unknown> | null> {
  const metadata = buildFeedItemMetadata(event);
  const boardType = event.metadata.boardType || (metadata.boardType as string | undefined);
  const climbConditions = [eq(dbSchema.boardClimbs.uuid, event.entityId)];
  if (boardType) {
    climbConditions.push(eq(dbSchema.boardClimbs.boardType, boardType));
  }

  const [climb] = await db
    .select({
      name: dbSchema.boardClimbs.name,
      boardType: dbSchema.boardClimbs.boardType,
      layoutId: dbSchema.boardClimbs.layoutId,
      setterUsername: dbSchema.boardClimbs.setterUsername,
      angle: dbSchema.boardClimbs.angle,
      frames: dbSchema.boardClimbs.frames,
      description: dbSchema.boardClimbs.description,
      isDraft: dbSchema.boardClimbs.isDraft,
      isListed: dbSchema.boardClimbs.isListed,
      difficultyName: dbSchema.boardDifficultyGrades.boulderName,
    })
    .from(dbSchema.boardClimbs)
    .leftJoin(
      dbSchema.boardClimbStats,
      and(
        eq(dbSchema.boardClimbStats.boardType, dbSchema.boardClimbs.boardType),
        eq(dbSchema.boardClimbStats.climbUuid, dbSchema.boardClimbs.uuid),
        eq(dbSchema.boardClimbStats.angle, dbSchema.boardClimbs.angle),
      ),
    )
    .leftJoin(
      dbSchema.boardDifficultyGrades,
      and(
        eq(dbSchema.boardDifficultyGrades.boardType, dbSchema.boardClimbs.boardType),
        eq(dbSchema.boardDifficultyGrades.difficulty, dbSchema.boardClimbStats.displayDifficulty),
      ),
    )
    .where(and(...climbConditions))
    .limit(1);

  if (!climb || climb.isDraft === true || climb.isListed === false) return null;

  const actorMetadata = await getActorMetadata(event.actorId);
  const setterUsername = (metadata.setterUsername as string | undefined) || climb.setterUsername || null;

  return {
    ...metadata,
    ...actorMetadata,
    actorDisplayName: metadata.actorDisplayName || actorMetadata.actorDisplayName || setterUsername,
    actorAvatarUrl: metadata.actorAvatarUrl || actorMetadata.actorAvatarUrl || null,
    climbName: metadata.climbName || climb.name || null,
    climbUuid: metadata.climbUuid || event.entityId,
    boardType: metadata.boardType || climb.boardType || boardType || null,
    layoutId: metadata.layoutId || climb.layoutId || null,
    setterUsername,
    angle: metadata.angle ?? climb.angle ?? null,
    frames: metadata.frames || climb.frames || null,
    difficultyName: metadata.difficultyName || climb.difficultyName || null,
    isNoMatch: metadata.isNoMatch || isNoMatchClimb(climb.description),
  };
}

async function getCommentContextMetadata(
  entityType: string,
  entityId: string,
): Promise<Record<string, unknown> | null> {
  if (entityType === 'tick') {
    const [tickContext] = await db
      .select({
        climbUuid: dbSchema.boardseshTicks.climbUuid,
        boardType: dbSchema.boardseshTicks.boardType,
        angle: dbSchema.boardseshTicks.angle,
        status: dbSchema.boardseshTicks.status,
        attemptCount: dbSchema.boardseshTicks.attemptCount,
        quality: dbSchema.boardseshTicks.quality,
        difficulty: dbSchema.boardseshTicks.difficulty,
        comment: dbSchema.boardseshTicks.comment,
        isMirror: dbSchema.boardseshTicks.isMirror,
        isBenchmark: dbSchema.boardseshTicks.isBenchmark,
        boardUuid: dbSchema.userBoards.uuid,
        climbName: dbSchema.boardClimbs.name,
        layoutId: dbSchema.boardClimbs.layoutId,
        frames: dbSchema.boardClimbs.frames,
        setterUsername: dbSchema.boardClimbs.setterUsername,
        climbDescription: dbSchema.boardClimbs.description,
        climbIsDraft: dbSchema.boardClimbs.isDraft,
        climbIsListed: dbSchema.boardClimbs.isListed,
        difficultyName: dbSchema.boardDifficultyGrades.boulderName,
      })
      .from(dbSchema.boardseshTicks)
      .leftJoin(
        dbSchema.boardClimbs,
        and(
          eq(dbSchema.boardClimbs.uuid, dbSchema.boardseshTicks.climbUuid),
          eq(dbSchema.boardClimbs.boardType, dbSchema.boardseshTicks.boardType),
        ),
      )
      .leftJoin(dbSchema.userBoards, eq(dbSchema.userBoards.id, dbSchema.boardseshTicks.boardId))
      .leftJoin(
        dbSchema.boardDifficultyGrades,
        and(
          eq(dbSchema.boardDifficultyGrades.boardType, dbSchema.boardseshTicks.boardType),
          eq(dbSchema.boardDifficultyGrades.difficulty, dbSchema.boardseshTicks.difficulty),
        ),
      )
      .where(eq(dbSchema.boardseshTicks.uuid, entityId))
      .limit(1);

    if (!tickContext) return {};
    if (tickContext.climbIsDraft === true || tickContext.climbIsListed === false) return null;

    return {
      climbUuid: tickContext.climbUuid,
      boardType: tickContext.boardType,
      angle: tickContext.angle,
      status: tickContext.status,
      attemptCount: tickContext.attemptCount,
      quality: tickContext.quality,
      difficulty: tickContext.difficulty,
      comment: tickContext.comment,
      isMirror: tickContext.isMirror ?? false,
      isBenchmark: tickContext.isBenchmark ?? false,
      boardUuid: tickContext.boardUuid,
      climbName: tickContext.climbName,
      layoutId: tickContext.layoutId,
      frames: tickContext.frames,
      setterUsername: tickContext.setterUsername,
      difficultyName: tickContext.difficultyName,
      isNoMatch: isNoMatchClimb(tickContext.climbDescription),
    };
  }

  if (entityType === 'climb') {
    const [climbContext] = await db
      .select({
        climbName: dbSchema.boardClimbs.name,
        climbUuid: dbSchema.boardClimbs.uuid,
        boardType: dbSchema.boardClimbs.boardType,
        layoutId: dbSchema.boardClimbs.layoutId,
        frames: dbSchema.boardClimbs.frames,
        setterUsername: dbSchema.boardClimbs.setterUsername,
        angle: dbSchema.boardClimbs.angle,
        description: dbSchema.boardClimbs.description,
        isDraft: dbSchema.boardClimbs.isDraft,
        isListed: dbSchema.boardClimbs.isListed,
      })
      .from(dbSchema.boardClimbs)
      .where(eq(dbSchema.boardClimbs.uuid, entityId))
      .limit(1);

    if (!climbContext) return {};
    if (climbContext.isDraft === true || climbContext.isListed === false) return null;

    return {
      climbName: climbContext.climbName,
      climbUuid: climbContext.climbUuid,
      boardType: climbContext.boardType,
      layoutId: climbContext.layoutId,
      frames: climbContext.frames,
      setterUsername: climbContext.setterUsername,
      angle: climbContext.angle,
      isNoMatch: isNoMatchClimb(climbContext.description),
    };
  }

  if (entityType === 'proposal') {
    return getProposalContextMetadata(entityId);
  }

  return {};
}

async function buildCommentMetadata(event: SocialEvent): Promise<Record<string, unknown> | null> {
  const commentUuid = event.metadata.commentUuid;
  if (!commentUuid) return null;

  const [comment] = await db
    .select({
      body: dbSchema.comments.body,
      entityType: dbSchema.comments.entityType,
      entityId: dbSchema.comments.entityId,
    })
    .from(dbSchema.comments)
    .where(eq(dbSchema.comments.uuid, commentUuid))
    .limit(1);

  if (!comment) return null;

  const [actorMetadata, contextMetadata] = await Promise.all([
    getActorMetadata(event.actorId),
    getCommentContextMetadata(comment.entityType, comment.entityId),
  ]);
  if (contextMetadata === null) return null;

  return {
    ...buildFeedItemMetadata(event),
    ...actorMetadata,
    ...contextMetadata,
    commentBody: truncateCommentBody(comment.body),
  };
}

async function getProposalContextMetadata(proposalUuid: string): Promise<Record<string, unknown>> {
  const [proposalContext] = await db
    .select({
      proposalType: dbSchema.climbProposals.type,
      climbUuid: dbSchema.climbProposals.climbUuid,
      boardType: dbSchema.climbProposals.boardType,
      angle: dbSchema.climbProposals.angle,
      climbName: dbSchema.boardClimbs.name,
      layoutId: dbSchema.boardClimbs.layoutId,
      frames: dbSchema.boardClimbs.frames,
      setterUsername: dbSchema.boardClimbs.setterUsername,
      description: dbSchema.boardClimbs.description,
    })
    .from(dbSchema.climbProposals)
    .leftJoin(
      dbSchema.boardClimbs,
      and(
        eq(dbSchema.boardClimbs.uuid, dbSchema.climbProposals.climbUuid),
        eq(dbSchema.boardClimbs.boardType, dbSchema.climbProposals.boardType),
      ),
    )
    .where(eq(dbSchema.climbProposals.uuid, proposalUuid))
    .limit(1);

  if (!proposalContext) return {};

  return {
    proposalType: proposalContext.proposalType,
    climbUuid: proposalContext.climbUuid,
    boardType: proposalContext.boardType,
    angle: proposalContext.angle,
    climbName: proposalContext.climbName,
    layoutId: proposalContext.layoutId,
    frames: proposalContext.frames,
    setterUsername: proposalContext.setterUsername,
    isNoMatch: isNoMatchClimb(proposalContext.description),
  };
}

async function buildProposalApprovedMetadata(event: SocialEvent): Promise<Record<string, unknown>> {
  const [actorMetadata, proposalMetadata] = await Promise.all([
    getActorMetadata(event.actorId),
    getProposalContextMetadata(event.entityId),
  ]);

  return {
    ...buildFeedItemMetadata(event),
    ...actorMetadata,
    ...proposalMetadata,
  };
}

/**
 * Fan out feed items to all followers of the event actor.
 * Inserts in batches of FANOUT_BATCH_SIZE to avoid unbounded single inserts.
 */
export async function fanoutFeedItems(event: SocialEvent): Promise<void> {
  const followerIds = await getUserFollowerIds(event.actorId);

  if (followerIds.length === 0) return;

  const metadata = {
    ...buildFeedItemMetadata(event),
    ...(await getActorMetadata(event.actorId)),
  };

  const allRows = uniqueRecipientIds(followerIds, event.actorId).map((recipientId) => ({
    recipientId,
    actorId: event.actorId,
    type: 'ascent' as const,
    entityType: 'tick' as SocialEntityType,
    entityId: event.entityId,
    // boardUuid is intentionally null when a climb isn't associated with a user board.
    // Board-scoped feed filtering simply won't match these items — they still appear
    // in the unfiltered "All" feed.
    boardUuid: event.metadata.boardUuid || null,
    metadata,
  }));

  await insertFeedRows(allRows);
}

/**
 * Fan out new climb feed items to followers of the setter.
 */
export async function fanoutNewClimbFeedItems(event: SocialEvent): Promise<void> {
  const metadata = await buildNewClimbMetadata(event);
  if (!metadata) return;

  const setterUsername = metadata.setterUsername as string | null | undefined;
  const [userFollowerIds, setterFollowerIds] = await Promise.all([
    getUserFollowerIds(event.actorId),
    getSetterFollowerIds(setterUsername),
  ]);
  const recipientIds = uniqueRecipientIds([...userFollowerIds, ...setterFollowerIds], event.actorId);

  if (recipientIds.length === 0) return;

  const rows = recipientIds.map((recipientId) => ({
    recipientId,
    actorId: event.actorId,
    type: 'new_climb' as const,
    entityType: 'climb' as SocialEntityType,
    entityId: event.entityId,
    boardUuid: null,
    metadata,
  }));

  await insertFeedRows(rows);
}

export async function fanoutCommentFeedItems(event: SocialEvent): Promise<void> {
  const commentUuid = event.metadata.commentUuid;
  if (!commentUuid) return;

  const followerIds = await getUserFollowerIds(event.actorId);
  const recipientIds = uniqueRecipientIds(followerIds, event.actorId);
  if (recipientIds.length === 0) return;

  const metadata = await buildCommentMetadata(event);
  if (!metadata) return;
  const boardUuid = (metadata.boardUuid as string | null | undefined) || event.metadata.boardUuid || null;

  const rows = recipientIds.map((recipientId) => ({
    recipientId,
    actorId: event.actorId,
    type: 'comment' as const,
    entityType: 'comment' as SocialEntityType,
    entityId: commentUuid,
    boardUuid,
    metadata,
  }));

  await insertFeedRows(rows);
}

export async function fanoutProposalApprovedFeedItems(event: SocialEvent): Promise<void> {
  const followerIds = await getUserFollowerIds(event.actorId);
  const recipientIds = uniqueRecipientIds(followerIds, event.actorId);
  if (recipientIds.length === 0) return;

  const metadata = await buildProposalApprovedMetadata(event);

  const rows = recipientIds.map((recipientId) => ({
    recipientId,
    actorId: event.actorId,
    type: 'proposal_approved' as const,
    entityType: 'proposal' as SocialEntityType,
    entityId: event.entityId,
    boardUuid: event.metadata.boardUuid || null,
    metadata,
  }));

  await insertFeedRows(rows);
}
