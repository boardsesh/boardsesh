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

/** Distinct OTHER humans on the roster, split by what the server says about their socket. */
export type SessionPeerCounts = {
  /** Peers the server reports live (or whose `connectionState` it does not report at all). */
  connected: number;
  /**
   * Peers inside the server's reconnect grace window: their socket dropped and
   * the roster is holding their seat until they come back or get evicted
   * (`SESSION_GRACE_PERIOD_MS` on the backend — a minute). Still crew, not yet
   * gone.
   */
  reconnecting: number;
};

/**
 * Count distinct OTHER humans on the roster, connected and reconnecting apart.
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
 * peers, not participants.
 *
 * The two buckets exist because the gate needs them for different things. Only
 * a CONNECTED peer can ARM it: a stale self-entry is `RECONNECTING` from the
 * moment the server notices the old socket is gone, and it stays that way for
 * the whole grace window, so counting it as present would take a lone climber's
 * board for a minute after every reconnect. But a peer who WAS connected and
 * flaps to `RECONNECTING` is still an audience — their wall stakes did not leave
 * with their wifi — so an armed gate is HELD by reconnecting peers and releases
 * only when the last of them is evicted or leaves. Without that, a peer's
 * socket blip made the next swipe commit to the shared queue, and re-arming
 * then cost the arrival dwell on top.
 *
 * `connectionState` is treated as connected when ABSENT, not when equal to
 * `'CONNECTED'`: a backend that does not send the field must behave as it did
 * before this filter existed rather than silently reporting an empty crew.
 */
export function countSessionPeers(
  users: readonly ConnectedRosterIdentity[] | null | undefined,
  self: SessionSelfIdentity,
): SessionPeerCounts {
  if (!users) return { connected: 0, reconnecting: 0 };
  const connected = new Set<string>();
  const reconnecting = new Set<string>();
  for (const user of users) {
    if (self.participantId != null && user.id === self.participantId) continue;
    if (self.userId != null && user.userId === self.userId) continue;
    const identity = user.userId ?? user.id;
    if (user.connectionState == null || user.connectionState === 'CONNECTED') connected.add(identity);
    else reconnecting.add(identity);
  }
  // One human with a live socket and a dying one is connected, not both.
  for (const identity of connected) reconnecting.delete(identity);
  return { connected: connected.size, reconnecting: reconnecting.size };
}

/**
 * Distinct OTHER humans who are actually connected right now — the arming count
 * for the browse gate. See {@link countSessionPeers} for the hold count.
 */
export function countConnectedSessionPeers(
  users: readonly ConnectedRosterIdentity[] | null | undefined,
  self: SessionSelfIdentity,
): number {
  return countSessionPeers(users, self).connected;
}
