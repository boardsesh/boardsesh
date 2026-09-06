// When the Climbs list teaches the quick-actions menu, and whether it should
// bother.
//
// The tip used to fire on the FIRST focus of the Climbs tab and mark itself seen
// on render — the worst possible moment, before a climber has any reason to want
// a menu, and one-shot forever. Production bore that out: of 214 people who
// opened the menu in a week, 154 used the ⋮ and only 86 ever found the
// long-press, with ~26 doing both. The two populations barely overlap.
//
// So the tip now waits for the climber's third landing on Climbs, and steps
// aside entirely for anyone who has already opened the menu by any route. Both
// signals are local: a counter and a boolean through the same keyed tip store
// that backs every other just-in-time tip.

import {
  ONBOARDING_TIP_QUICKACTIONS_KEY,
  ONBOARDING_TIP_QUICKACTIONS_USED_KEY,
  ONBOARDING_TIP_QUICKACTIONS_VISITS_KEY,
} from '@boardsesh/key-value-storage';
import { hasSeenTip, markTipSeen, recordTipVisit } from './onboarding-storage';

/**
 * Climbs-tab visits required before the tip may show. Three, not one: the first
 * visit is spent finding your board and the second reading the list, so the
 * third is the earliest moment a "there's a menu on these rows" tip is an answer
 * to a question the climber has actually formed.
 */
export const QUICK_ACTIONS_TIP_MIN_VISITS = 3;

/**
 * Stable `tip` property for the Onboarding Tip Shown / Dismissed / Pressed
 * events. Kept next to the rule so a copy rewrite can never silently rename the
 * thing PostHog is counting.
 */
export const QUICK_ACTIONS_TIP_NAME = 'quick_actions';

/** Everything the arming decision depends on, so the rule can be tested alone. */
export type QuickActionsTipSignals = {
  /** The existing one-shot seen flag. Anyone taught under the old timing keeps it. */
  alreadySeen: boolean;
  /** The climber has opened the quick-actions menu at least once, anywhere. */
  hasOpenedActions: boolean;
  /** Landings on the Climbs tab, including this one. */
  visitCount: number;
};

/**
 * Whether the quick-actions tip may show now.
 *
 * `hasOpenedActions` beats everything: there is nothing to teach someone who
 * already found the menu, whichever way they found it. `alreadySeen` keeps the
 * old promise — a climber who got the tip under the first-visit timing must not
 * be shown it a second time under the new one.
 */
export function shouldArmQuickActionsTip({
  alreadySeen,
  hasOpenedActions,
  visitCount,
}: QuickActionsTipSignals): boolean {
  if (alreadySeen || hasOpenedActions) return false;
  return visitCount >= QUICK_ACTIONS_TIP_MIN_VISITS;
}

/**
 * Read the three signals and decide, counting this visit as one.
 *
 * The read order matters for writes, not for the answer: `hasSeenTip` is checked
 * first so a climber past the tip stops incrementing the counter. Returns the
 * visit count alongside the verdict so `Onboarding Tip Shown` can report which
 * visit armed it — otherwise the timing rule is unfalsifiable in PostHog.
 */
export async function resolveQuickActionsTip(): Promise<{ armed: boolean; visitCount: number }> {
  const [alreadySeen, hasOpenedActions] = await Promise.all([
    hasSeenTip(ONBOARDING_TIP_QUICKACTIONS_KEY),
    hasSeenTip(ONBOARDING_TIP_QUICKACTIONS_USED_KEY),
  ]);
  if (alreadySeen || hasOpenedActions) return { armed: false, visitCount: 0 };
  const visitCount = await recordTipVisit(ONBOARDING_TIP_QUICKACTIONS_VISITS_KEY, QUICK_ACTIONS_TIP_MIN_VISITS);
  return { armed: shouldArmQuickActionsTip({ alreadySeen, hasOpenedActions, visitCount }), visitCount };
}

// Opening the menu is a hot path — every long-press and every ⋮ tap lands here —
// and the flag only ever goes from unset to true. One write per launch is enough;
// this guard keeps the other N out of SecureStore.
let quickActionsUsedThisLaunch = false;

/**
 * Record that the quick-actions menu was opened, so the tip never fires again.
 * Called from the one place every surface's menu goes through
 * (DrawerHostProvider's `openClimbActions`) rather than from a row, so a
 * long-press on a playlist or a profile counts exactly like one on Climbs.
 */
export async function markQuickActionsUsed(): Promise<void> {
  if (quickActionsUsedThisLaunch) return;
  quickActionsUsedThisLaunch = true;
  await markTipSeen(ONBOARDING_TIP_QUICKACTIONS_USED_KEY);
}

/** Test-only: forget the per-launch guard between cases. */
export function resetQuickActionsUsedGuard(): void {
  quickActionsUsedThisLaunch = false;
}
