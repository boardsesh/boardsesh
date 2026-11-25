import type { PrivacyResourceAudience } from '@boardsesh/graphql/operations/privacy';

/**
 * Whether a board owner is offered "Show to people I follow".
 *
 * Public and Followers boards already appear in the Friends' boards list of
 * everyone who follows the owner, and Only me never does, so the switch only
 * means something for Unlisted and Invite-only. A spray wall can't be listed
 * this way (the server rejects it), so it never gets the row.
 */
export function showsFriendsListSwitch(audience: PrivacyResourceAudience, isSprayWall: boolean): boolean {
  if (isSprayWall) return false;
  return audience === 'unlisted' || audience === 'invite_only';
}
