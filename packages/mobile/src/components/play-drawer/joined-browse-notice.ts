/**
 * One-shot bookkeeping for the "you're browsing" notice.
 *
 * The notice explains a rule the climber never opted into: something silently
 * changed what a swipe does — joining a crew, or turning board lighting off for
 * swipes and taps. It has to be shown, and it has to be shown ONCE, because a
 * card that reappears every time the drawer opens is the thing people remember
 * about a feature instead of the feature.
 *
 * Two claims, because the two facts have different lifetimes:
 *
 *  - the crew rule lives as long as the crew does, so it is claimed per session
 *    id in module state (not a ref inside PlayDrawer — the drawer is a modal
 *    route and unmounts on every dismiss, which would re-fire the card on the
 *    next open). Joining a DIFFERENT crew later explains itself again, and the
 *    claim dying with the app only means a climber who force-quit mid-session
 *    gets told once more;
 *  - the lighting-setting rule is a decision the climber made on a device they
 *    keep, so its claim is persisted.
 */
import { getSetting, setSetting } from '../../settings';

const noticedSessionIds = new Set<string>();

/**
 * Claim the notice for this session: true exactly once per session id, false
 * every time after. Solo (`null`) never claims — see
 * {@link claimSoloBrowseNotice} for the other half.
 */
export function claimJoinedBrowseNotice(sessionId: string | null): boolean {
  if (!sessionId || noticedSessionIds.has(sessionId)) return false;
  noticedSessionIds.add(sessionId);
  return true;
}

/**
 * The solo half of the same explanation: a climber who turned board lighting off
 * for swipes or taps (#4640) also navigates without driving their board, and
 * nothing else tells them so.
 *
 * Persisted rather than held in memory, unlike the crew claim above, because the
 * fact it records is permanent: a setting the climber changed once, on a device
 * they keep. An in-memory claim would re-explain it on every cold start, which is
 * exactly the card-everyone-remembers-instead-of-the-feature failure.
 */
export function claimSoloBrowseNotice(): boolean {
  if (getSetting('browseNoticeSeen')) return false;
  setSetting('browseNoticeSeen', true);
  return true;
}

/**
 * Clear the claim ledger. Test-only: the Set outlives an individual test, so
 * without this a second case reusing a session id would see no notice and pass
 * for the wrong reason. (The solo claim lives in settings, which the suites reset
 * with `resetAllSettings`.)
 */
export function _resetJoinedBrowseNoticeForTests(): void {
  noticedSessionIds.clear();
}
