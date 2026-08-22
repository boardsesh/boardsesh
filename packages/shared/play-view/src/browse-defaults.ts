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
   * Distinct HUMANS on the roster, counted with
   * `countDistinctSessionUsers` — not the raw roster length. A reconnect that
   * lands before the previous connection's `UserLeft` briefly doubles a lone
   * climber, and counting that would flip a solo session into browse-by-default
   * for no reason.
   */
  distinctUserCount: number;
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
 */
export function shouldDefaultToBrowse({ sessionActive, distinctUserCount }: BrowseDefaultInput): boolean {
  return sessionActive && distinctUserCount > 1;
}
