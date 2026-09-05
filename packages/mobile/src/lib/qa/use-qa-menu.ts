import { useMemo, useState } from 'react';
import { useSetting } from '../../settings/hooks';
import { useProfile } from '../graphql/hooks';
import { useOtaBranchSurfingState } from '../ota-branch-surfing-state';
import { runningQaPrNumberToOffer } from './qa-drawer-rows';
import { readRunningPrNumber } from './qa-surf';

/**
 * What a menu should offer for the PR-preview (crowdsourced QA) flow — shared by
 * the user drawer and the More tab so the two can never drift apart.
 *
 * `show` is the binary's capability alone. Every signed-in user gets the entry
 * point: the picker is the one surface that can SAY why there is nothing to load
 * ("Previews are switched off", "Nothing to test right now"), and hiding it left
 * everyone but a tester with only xprem's edge marker — which renders nothing at
 * all in exactly those cases, so "no marker" and "no previews" looked identical.
 * A build that cannot surf still hides it: there the row would offer something
 * the binary genuinely cannot do.
 *
 * The cold-start prompt is a different question and stays tester-only; see
 * `decideQaGate`.
 */
export type QaMenuState = {
  /** Offer the QA entry point at all. */
  show: boolean;
  /** The PR whose preview is running and still wants a verdict, else null. */
  prNumber: number | null;
};

export function useQaMenu(): QaMenuState {
  const { data: profile } = useProfile();
  const { surfingBuild } = useOtaBranchSurfingState();
  // The running branch cannot change without a reload, so a mount-time read is
  // the whole story.
  const [runningPrNumber] = useState(() => readRunningPrNumber());
  // Subscribed, not read once: the More tab stays mounted while the verdict
  // sheet writes this marker, so a snapshot would leave it offering "Finish
  // testing" for a verdict already filed until the tab remounted. (The drawer
  // is a route and unmounts, which is why this went unnoticed there.)
  const [verdictSubmittedKey] = useSetting('qaVerdictSubmittedKey');
  // Which rows it earns is re-derived from the signed-in account too: the
  // markers are account-scoped, so tester A's sign-off must not follow tester B
  // onto the same device.
  const prNumber = useMemo(
    () => runningQaPrNumberToOffer(runningPrNumber, profile?.id, verdictSubmittedKey),
    [runningPrNumber, profile?.id, verdictSubmittedKey],
  );

  return { show: surfingBuild, prNumber };
}
