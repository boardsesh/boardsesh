import { getPreference, removePreferencesMatching, setPreference } from './preference-store';
import type { UserStorageOwner } from './user-storage-owner';

// One shared (unscoped) index mapping each seen login scope to the last time it
// was the active owner. Used only to age out orphaned scopes; never holds
// account data itself.
const OWNER_ACTIVITY_INDEX_KEY = 'boardsesh_web_owner_activity_v1';
// Reclaim a login's rows only after it has been inactive this long. A shorter
// window would risk deleting data a concurrent tab (or a rapid authSession
// rotation, e.g. relogin as the same user) still legitimately owns. Matches the
// 30-day NextAuth session-cookie lifetime after which the login is truly gone.
const ORPHAN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

type OwnerActivityIndex = Record<string, number>;

let currentUserStorageOwner: UserStorageOwner | null = null;
let lastSweptOwnerScope: string | null = null;

function ownerScope(owner: UserStorageOwner): string {
  // `encodeURIComponent` escapes `:`, so it is a safe field separator.
  return `${encodeURIComponent(owner.userId)}:${encodeURIComponent(owner.authSessionId)}`;
}

function scopeRowSuffix(encodedScope: string): string {
  const separatorIndex = encodedScope.indexOf(':');
  const encodedUserId = encodedScope.slice(0, separatorIndex);
  const encodedAuthSessionId = encodedScope.slice(separatorIndex + 1);
  // Row keys end exactly with this; `endsWith` avoids a session-id prefix
  // (`session-a1`) matching a longer sibling (`session-a12`).
  return `:user:${encodedUserId}:auth-session:${encodedAuthSessionId}`;
}

async function readOwnerActivityIndex(): Promise<OwnerActivityIndex> {
  const stored = await getPreference<OwnerActivityIndex>(OWNER_ACTIVITY_INDEX_KEY);
  return stored && typeof stored === 'object' ? stored : {};
}

/**
 * Reclaim IndexedDB rows stranded by a prior login of the *same user*. Each key
 * bakes in the login-scoped `authSessionId`, so a browser close or cookie expiry
 * (paths the explicit sign-out cleanup never runs) leaves the old login's active
 * board, queue snapshot, session, and drafts orphaned forever. This records the
 * settled login as active now, then deletes rows for this user's *other* login
 * scopes only once they have been inactive past the retention window — so a
 * concurrent tab or a rapid authSession switch never loses data it still owns.
 * Rows for other users are left to the explicit sign-out cleanup path.
 */
export async function sweepOrphanedUserStorage(owner: UserStorageOwner, now: number = Date.now()): Promise<void> {
  const index = await readOwnerActivityIndex();
  const currentScope = ownerScope(owner);
  index[currentScope] = now;

  const encodedUserId = encodeURIComponent(owner.userId);
  const staleScopes = Object.keys(index).filter(
    (scope) =>
      scope !== currentScope && scope.startsWith(`${encodedUserId}:`) && now - index[scope] > ORPHAN_RETENTION_MS,
  );

  if (staleScopes.length > 0) {
    const staleSuffixes = staleScopes.map(scopeRowSuffix);
    await removePreferencesMatching((key) => staleSuffixes.some((suffix) => key.endsWith(suffix)));
    for (const scope of staleScopes) delete index[scope];
  }
  await setPreference(OWNER_ACTIVITY_INDEX_KEY, index);
}

/** Set before authenticated children mount so their first storage read is scoped. */
export function setCurrentUserStorageOwner(owner: UserStorageOwner | null): void {
  currentUserStorageOwner = owner;
  if (!owner) {
    // Sign-out clears the dedup so the next sign-in runs the sweep again — even
    // for the same user id, whose new login mints a fresh authSessionId scope.
    lastSweptOwnerScope = null;
    return;
  }
  const scope = ownerScope(owner);
  if (scope === lastSweptOwnerScope) return;
  lastSweptOwnerScope = scope;
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
