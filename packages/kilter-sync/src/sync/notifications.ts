import { randomUUID } from 'crypto';
import { inArray } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { setterFollows, userBoardMappings, userFollows, notifications } from '@boardsesh/db/schema';

type DrizzleDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** A newly-inserted canonical climb, enough to notify the setter's followers. */
export type NewClimbInfo = {
  uuid: string;
  setterUsername?: string | null;
  layoutId: number;
  name?: string | null;
};

const NOTIFICATION_CHUNK = 1000;

async function chunked<T>(rows: T[], fn: (chunk: T[]) => Promise<void>): Promise<void> {
  for (let i = 0; i < rows.length; i += NOTIFICATION_CHUNK) {
    await fn(rows.slice(i, i + NOTIFICATION_CHUNK));
  }
}

/**
 * Notify followers of a setter when their new climbs are ingested. Ported
 * from aurora-sync `shared-sync.ts:createSetterSyncNotifications` — same
 * behaviour, keyed on `setterUsername` (Kilter has no integer setter id, so
 * `setterId` is intentionally absent here). A follower is either a direct
 * setter-follow, or a Boardsesh user following the Boardsesh account linked
 * to that board username.
 */
export async function createSetterSyncNotifications(
  db: DrizzleDb,
  newClimbs: NewClimbInfo[],
  log: (message: string) => void,
): Promise<void> {
  const climbsBySetter = new Map<string, NewClimbInfo[]>();
  for (const climb of newClimbs) {
    if (!climb.setterUsername) continue;
    const list = climbsBySetter.get(climb.setterUsername) ?? [];
    list.push(climb);
    climbsBySetter.set(climb.setterUsername, list);
  }
  if (climbsBySetter.size === 0) return;

  const setterUsernames = [...climbsBySetter.keys()];

  const followers = await db
    .select({ followerId: setterFollows.followerId, setterUsername: setterFollows.setterUsername })
    .from(setterFollows)
    .where(inArray(setterFollows.setterUsername, setterUsernames));

  const linkedMappings = await db
    .select({ userId: userBoardMappings.userId, boardUsername: userBoardMappings.boardUsername })
    .from(userBoardMappings)
    .where(inArray(userBoardMappings.boardUsername, setterUsernames));

  const linkedUsernameToUserId = new Map<string, string>();
  for (const mapping of linkedMappings) {
    if (mapping.boardUsername) linkedUsernameToUserId.set(mapping.boardUsername, mapping.userId);
  }

  const linkedUserIds = [...linkedUsernameToUserId.values()];
  let userFollowsList: Array<{ followerId: string; followingId: string }> = [];
  if (linkedUserIds.length > 0) {
    userFollowsList = await db
      .select({ followerId: userFollows.followerId, followingId: userFollows.followingId })
      .from(userFollows)
      .where(inArray(userFollows.followingId, linkedUserIds));
  }

  for (const [setterUsername, climbs] of climbsBySetter) {
    const recipientIds = new Set<string>();
    for (const follow of followers) {
      if (follow.setterUsername === setterUsername) recipientIds.add(follow.followerId);
    }
    const linkedUserId = linkedUsernameToUserId.get(setterUsername);
    if (linkedUserId) {
      for (const follow of userFollowsList) {
        if (follow.followingId === linkedUserId) recipientIds.add(follow.followerId);
      }
    }
    if (recipientIds.size === 0) continue;

    const firstClimbUuid = climbs[0].uuid;
    const values = [...recipientIds].map((recipientId) => ({
      uuid: randomUUID(),
      recipientId,
      actorId: linkedUserId ?? null,
      type: 'new_climbs_synced' as const,
      entityType: 'climb' as const,
      entityId: firstClimbUuid,
    }));

    await chunked(values, async (chunk) => {
      await db.insert(notifications).values(chunk);
    });
    log(`[kilter-catalog] ${values.length} notifications for setter "${setterUsername}" (${climbs.length} new climbs)`);
  }
}
