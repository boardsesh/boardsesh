/** Renderer-independent privacy decisions. Database relationships are injected. */
export type PrivacyAudience = 'public' | 'followers' | 'only_me';
export type PrivacyResourceAudience = PrivacyAudience | 'unlisted' | 'invite_only';
export type PrivacyLocationAudience = PrivacyAudience | 'members';
export type PrivacyResourceKind = 'board' | 'session';
export type PrivacyContentType = 'tick' | 'session' | 'comment' | 'climb' | 'playlist' | 'beta';
export interface PrivacySettings {
  isPrivate: boolean;
  privacyRevision: number;
  defaultSessionAudience: PrivacyResourceAudience;
  /** Show as an anonymous climber on boards the climber doesn't own. A plain preference, not behind `enabled`. */
  anonymousOnForeignBoards: boolean;
  enabled: boolean;
}
export interface PrivacyViewer {
  isOwner: boolean;
  isApprovedFollower: boolean;
}
export function canReadActivity(isPrivate: boolean, viewer: PrivacyViewer): boolean {
  return viewer.isOwner || !isPrivate || viewer.isApprovedFollower;
}
export function canReadContent(
  settings: Pick<PrivacySettings, 'isPrivate' | 'privacyRevision'>,
  content: { audience: PrivacyAudience; publicConsentRevision: number | null } | null,
  viewer: PrivacyViewer,
): boolean {
  if (viewer.isOwner) return true;
  const audience = content?.audience ?? (settings.isPrivate ? 'followers' : 'public');
  if (audience === 'only_me') return false;
  if (audience === 'followers') return viewer.isApprovedFollower;
  if (!settings.isPrivate || content?.publicConsentRevision === settings.privacyRevision) return true;
  return viewer.isApprovedFollower;
}
export function canReadResource(
  audience: PrivacyResourceAudience,
  viewer: PrivacyViewer & { hasApprovedGrant: boolean; hasRevokedGrant: boolean; inheritFollowers: boolean },
): boolean {
  if (viewer.isOwner) return true;
  if (viewer.hasRevokedGrant) return false;
  if (audience === 'public' || audience === 'unlisted') return true;
  if (audience === 'only_me') return false;
  return (
    viewer.hasApprovedGrant || ((audience === 'followers' || viewer.inheritFollowers) && viewer.isApprovedFollower)
  );
}
/**
 * Location audiences a writer may store. `followers` is not offered for a
 * location: on a public account follows are approved automatically, so it would
 * reveal the address to anyone who taps Follow. An incoming `followers` (an
 * older client, or a stored choice) is narrowed to `members`, the people the
 * owner invited. The value stays in the type and the database check so old rows
 * and old clients keep working.
 */
export function normalizeLocationAudience(audience: PrivacyLocationAudience): PrivacyLocationAudience {
  return audience === 'followers' ? 'members' : audience;
}
export function canReadLocation(
  audience: PrivacyLocationAudience,
  viewer: PrivacyViewer & { hasResourceAccess: boolean; hasApprovedGrant: boolean },
): boolean {
  if (viewer.isOwner) return true;
  if (!viewer.hasResourceAccess) return false;
  if (audience === 'public') return true;
  if (audience === 'followers') return viewer.isApprovedFollower;
  if (audience === 'members') return viewer.hasApprovedGrant;
  return false;
}
