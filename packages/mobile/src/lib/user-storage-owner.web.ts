import { removePreferencesMatching } from './preference-store';
import type { UserStorageOwner } from './user-storage-owner';

let currentUserStorageOwner: UserStorageOwner | null = null;
let lastSweptOwnerKey: string | null = null;

function ownerKey(owner: UserStorageOwner): string {
  return `${encodeURIComponent(owner.userId)}:${encodeURIComponent(owner.authSessionId)}`;
}

function userScopeMarker(userId: string): string {
  return `:user:${encodeURIComponent(userId)}:auth-session:`;
}

/**
 * Reclaim IndexedDB rows stranded by a prior login of the *same user*. Each key
 * bakes in the login-scoped `authSessionId`, so logging out and back in (or a
 * cookie expiry) leaves the old login's active board, queue snapshot, session,
 * and drafts orphaned forever. On a settled login this deletes every row that
 * carries this user's id under a different `authSessionId`, bounding growth to
 * one live login per user. Rows for *other* users are left untouched — those are
 * cleared through the explicit sign-out cleanup path.
 */
export async function sweepOrphanedUserStorage(owner: UserStorageOwner): Promise<void> {
  const marker = userScopeMarker(owner.userId);
  const currentSuffix = `${marker}${encodeURIComponent(owner.authSessionId)}`;
  await removePreferencesMatching((key) => key.includes(marker) && !key.endsWith(currentSuffix));
}

/** Set before authenticated children mount so their first storage read is scoped. */
export function setCurrentUserStorageOwner(owner: UserStorageOwner | null): void {
  currentUserStorageOwner = owner;
  if (!owner) return;
  const key = ownerKey(owner);
  if (key === lastSweptOwnerKey) return;
  lastSweptOwnerKey = key;
  // Best-effort GC; a slow or failed sweep must never block the authed UI.
  void sweepOrphanedUserStorage(owner).catch(() => {});
}

/**
 * Resolve an account-specific key once, at operation start. Passing an explicit
 * owner lets auth cleanup target the account that is leaving while another tab
 * or a newer transition writes under a different owner.
 */
export function userScopedStorageKey(baseKey: string, owner?: UserStorageOwner | null): string | null {
  const resolvedOwner = owner === undefined ? currentUserStorageOwner : owner;
  if (!resolvedOwner) return null;
  return (
    `${baseKey}:user:${encodeURIComponent(resolvedOwner.userId)}` +
    `:auth-session:${encodeURIComponent(resolvedOwner.authSessionId)}`
  );
}
