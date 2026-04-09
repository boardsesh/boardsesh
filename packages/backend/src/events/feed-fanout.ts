import type { SocialEvent } from '@boardsesh/shared-schema';
import type { SocialEntityType } from '@boardsesh/db/schema';
import { createRequestDb, type RequestDbInstance } from '../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { eq } from 'drizzle-orm';
import { buildFeedItemMetadata } from './feed-metadata';

export { buildFeedItemMetadata } from './feed-metadata';

const FANOUT_BATCH_SIZE = 1000;

/**
 * Fan out feed items to all followers of the event actor.
 * Inserts in batches of FANOUT_BATCH_SIZE to avoid unbounded single inserts.
 */
export async function fanoutFeedItems(db: RequestDbInstance, event: SocialEvent): Promise<void> {
  const followers = await db
    .select({ followerId: dbSchema.userFollows.followerId })
    .from(dbSchema.userFollows)
    .where(eq(dbSchema.userFollows.followingId, event.actorId));

  if (followers.length === 0) return;

  const metadata = buildFeedItemMetadata(event);

  const allRows = followers.map((f) => ({
    recipientId: f.followerId,
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

  // Insert in batches to bound memory and query size for popular users
  for (let i = 0; i < allRows.length; i += FANOUT_BATCH_SIZE) {
    const batch = allRows.slice(i, i + FANOUT_BATCH_SIZE);
    await db.insert(dbSchema.feedItems).values(batch);
  }
}

/**
   * Fan out new climb feed items to followers of the setter.
   */
export async function fanoutNewClimbFeedItems(db: RequestDbInstance, event: SocialEvent): Promise<void> {
  const followers = await db
    .select({ followerId: dbSchema.userFollows.followerId })
    .from(dbSchema.userFollows)
    .where(eq(dbSchema.userFollows.followingId, event.actorId));

  if (followers.length === 0) return;

  const metadata = buildFeedItemMetadata(event);

  const rows = followers.map((f) => ({
    recipientId: f.followerId,
    actorId: event.actorId,
    type: 'new_climb' as const,
    entityType: 'climb' as SocialEntityType,
    entityId: event.entityId,
    boardUuid: null,
    metadata,
  }));

  for (let i = 0; i < rows.length; i += FANOUT_BATCH_SIZE) {
    const batch = rows.slice(i, i + FANOUT_BATCH_SIZE);
    await db.insert(dbSchema.feedItems).values(batch);
  }
}

