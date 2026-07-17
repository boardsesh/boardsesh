import type { UserStorageOwner } from './user-storage-owner';

let currentUserStorageOwner: UserStorageOwner | null = null;

/** Set before authenticated children mount so their first storage read is scoped. */
export function setCurrentUserStorageOwner(owner: UserStorageOwner | null): void {
  currentUserStorageOwner = owner;
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
