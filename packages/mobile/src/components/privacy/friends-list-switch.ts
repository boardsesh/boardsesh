import type { PrivacyResourceAudience } from '@boardsesh/graphql/operations/privacy';

/** The gym fields that decide whether a board at it counts as a home wall. */
export type FriendsListGym = { ownerId?: string | null; isPublic: boolean; isListed?: boolean };

/**
 * Whether a board owner is offered "Show to friends".
 *
 * Public and Followers boards already appear in the Friends' boards list of
 * the owner's friends (they follow the owner), and Only me never does, so the switch only
 * means something for Unlisted and Invite-only. A spray wall can't be listed
 * this way (the server rejects it), so it never gets the row.
 *
 * Friends' boards only lists home walls (the backend's `homeWallCondition`): a
 * board at someone else's gym, or at a public listed gym, is found through
 * that gym instead, so the switch would do nothing there. `gym` is `null` for
 * no gym (or one that is gone) and `undefined` while it is still loading,
 * which hides the row until the answer is known.
 */
export function showsFriendsListSwitch(
  audience: PrivacyResourceAudience,
  isSprayWall: boolean,
  gym: FriendsListGym | null | undefined,
  boardOwnerId: string | null,
): boolean {
  if (isSprayWall) return false;
  if (audience !== 'unlisted' && audience !== 'invite_only') return false;
  if (gym === undefined) return false;
  if (gym === null) return true;
  // `isListed` is always selected; read a missing one as listed, the safe side.
  return gym.ownerId === boardOwnerId && !(gym.isPublic && gym.isListed !== false);
}
