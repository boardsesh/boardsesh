import type { RuntimeSessionUser } from './session-events';

type RosterIdentity = Pick<RuntimeSessionUser, 'id' | 'userId'>;

/**
 * Collapse a session roster to one entry per human. Authenticated users dedupe
 * by their stable `userId`; anonymous users (no `userId`) fall back to their
 * per-connection `id` so genuinely distinct anonymous participants aren't
 * merged. Order is preserved and the first entry seen for each identity wins.
 *
 * Use this anywhere a human-facing crew list or count is derived from the
 * roster (peerCount, partyMode, presence avatars). The roster can briefly carry
 * more than one entry for the same person — e.g. a reconnect that arrives before
 * the previous connection's `UserLeft`, or a logged-in user whose socket
 * momentarily authenticated anonymously — and counting the raw length turns a
 * lone climber into a false "party".
 *
 * NOT for id-based lookups: keep the raw roster when you need to `find` a
 * participant by connection/participant `id`, since dedupe drops later entries.
 */
export function dedupeSessionUsers<TUser extends RosterIdentity>(users: readonly TUser[] | null | undefined): TUser[] {
  if (!users) return [];
  const seen = new Set<string>();
  const deduped: TUser[] = [];
  for (const user of users) {
    const key = user.userId ?? user.id;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(user);
  }
  return deduped;
}

/** Count distinct humans in a session roster (see {@link dedupeSessionUsers}). */
export function countDistinctSessionUsers(users: readonly RosterIdentity[] | null | undefined): number {
  if (!users) return 0;
  const seen = new Set<string>();
  for (const user of users) {
    seen.add(user.userId ?? user.id);
  }
  return seen.size;
}

/** Who the local client is, for excluding its own roster entries. */
export type SessionSelfIdentity = {
  /** `RuntimeSessionState.participantId` — the key roster entries carry as `id`. */
  participantId?: string | null;
  /** The signed-in user's stable id, when there is one. */
  userId?: string | null;
};

type ConnectedRosterIdentity = Pick<RuntimeSessionUser, 'id' | 'userId' | 'connectionState'>;

/**
 * Count distinct OTHER humans who are actually connected right now.
 *
 * {@link countDistinctSessionUsers} answers "how many people are in this
 * session", which is the right question for an avatar row: a peer who is
 * reconnecting is still one of the crew and should stay on screen. It is the
 * wrong question for a gate that decides whether a gesture drives the wall,
 * because it counts two things that are not an audience:
 *
 *  - **The climber themselves.** The roster always contains you.
 *  - **Your own stale entry.** A reconnect that lands before the previous
 *    connection's `UserLeft`, or a socket that momentarily authenticated
 *    anonymously, leaves a second entry for one human keyed on the old
 *    connection id — a different key from the authenticated one, so dedupe by
 *    `userId ?? id` cannot merge them.
 *
 * Either one turns a lone climber into a false crew, and a gate that reads a
 * false crew stops their swipes from lighting their own board. So this counts
 * peers, not participants, and only ones the server says are live.
 *
 * `connectionState` is treated as connected when ABSENT, not when equal to
 * `'CONNECTED'`: a backend that does not send the field must behave as it did
 * before this filter existed rather than silently reporting an empty crew.
 */
export function countConnectedSessionPeers(
  users: readonly ConnectedRosterIdentity[] | null | undefined,
  self: SessionSelfIdentity,
): number {
  if (!users) return 0;
  const seen = new Set<string>();
  for (const user of users) {
    if (user.connectionState != null && user.connectionState !== 'CONNECTED') continue;
    if (self.participantId != null && user.id === self.participantId) continue;
    if (self.userId != null && user.userId === self.userId) continue;
    seen.add(user.userId ?? user.id);
  }
  return seen.size;
}
