/**
 * When a browse-shaped gesture should default to LOOKING rather than driving
 * the wall.
 *
 * The rule is about audience, not permissions. Solo, a swipe through the play
 * drawer is a private act: it lights your own board and nobody else notices.
 * The moment a second climber is in the session, that same swipe writes the
 * shared queue — it blanks a climb someone may be mid-attempt on and it moves
 * everyone's next-up. Browsing must not cost that, so with an audience present
 * every browse-shaped gesture lands view-only and the wall changes only when
 * the climber explicitly puts a climb up.
 *
 * Kept pure and shared (rather than inlined in the drawer) because two very
 * different surfaces have to agree on it — the play drawer's swipes and the
 * climb list's row taps — and a disagreement between them is invisible: one
 * would promise browsing while the other quietly took the wall.
 */
export type BrowseDefaultInput = {
  /** A party session is joined (a session id exists). */
  sessionActive: boolean;
  /**
   * Distinct OTHER humans currently connected, counted with
   * `countConnectedSessionPeers` — peers, not participants, and not the raw
   * roster length.
   *
   * Counting participants was the original shape and it was wrong in a way that
   * only showed up in the field: the roster always contains you, and it can
   * briefly contain you TWICE (a reconnect that lands before the previous
   * connection's `UserLeft`, or a socket that momentarily authenticated
   * anonymously — two different keys for one human, so dedupe cannot merge
   * them). Either one reads as a crew, and a false crew stops a lone climber's
   * swipes from lighting their own board. Counting connected peers removes both
   * failure modes at the source.
   */
  connectedPeerCount: number;
};

/**
 * True when browse-shaped gestures should stay view-only by default.
 *
 * Both clauses are load-bearing. A session of one is still solo — it is the
 * ordinary state right after starting a session and before anyone joins, and
 * making it browse-by-default would take away the one-swipe wall control the
 * climber started the session with. And a roster with entries but no session id
 * is stale bookkeeping from a session that has already ended, which must not
 * keep gating gestures.
 *
 * This answers the question for an INSTANT. It deliberately says nothing about
 * how long the crew has been there — callers hold the answer for a dwell before
 * acting on it, so a one-frame roster blip cannot flip a climber into browsing
 * (see `queue-provider`). Turning the gate back OFF is not dwelled: a climber
 * left alone gets their board back immediately.
 */
export function shouldDefaultToBrowse({ sessionActive, connectedPeerCount }: BrowseDefaultInput): boolean {
  return sessionActive && connectedPeerCount > 0;
}
