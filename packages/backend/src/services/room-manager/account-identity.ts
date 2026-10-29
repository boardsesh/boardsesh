import { eq } from 'drizzle-orm';
import { users, userProfiles } from '@boardsesh/db/schema';
import { db } from '../../db/client';
import { logger } from '../../utils/logger';
import { AvatarUrlSchema, UsernameSchema } from '../../validation/schemas/primitives';

export type AccountSessionIdentity = {
  username: string | undefined;
  avatarUrl: string | undefined;
};

/**
 * The roster identity of a signed-in account, read from its profile: display
 * name else account name, profile avatar else account image. The same
 * fallbacks the `profile` query applies, which is what the apps send with
 * JOIN_SESSION when they have it.
 *
 * Used when an authenticated connection joins a session without naming
 * itself (the iOS Live Activity socket never does, #7018). Without it the
 * join wrote the per-connection `User-xxxxxx` placeholder over the shared
 * participant row the app's own socket had named.
 *
 * Values the join schema would reject are dropped, and a failed read returns
 * nothing: the join then keeps the placeholder rather than failing.
 */
export async function loadAccountSessionIdentity(userId: string): Promise<AccountSessionIdentity> {
  try {
    const [row] = await db
      .select({
        name: users.name,
        image: users.image,
        displayName: userProfiles.displayName,
        profileAvatarUrl: userProfiles.avatarUrl,
      })
      .from(users)
      .leftJoin(userProfiles, eq(users.id, userProfiles.userId))
      .where(eq(users.id, userId))
      .limit(1);
    if (!row) return { username: undefined, avatarUrl: undefined };

    const username = row.displayName?.trim() || row.name?.trim() || undefined;
    const avatarUrl = row.profileAvatarUrl || row.image || undefined;
    return {
      username: username && UsernameSchema.safeParse(username).success ? username : undefined,
      avatarUrl: avatarUrl && AvatarUrlSchema.safeParse(avatarUrl).success ? avatarUrl : undefined,
    };
  } catch (err) {
    logger.warn(`[RoomManager] Could not read the account identity for a session join:`, err);
    return { username: undefined, avatarUrl: undefined };
  }
}
