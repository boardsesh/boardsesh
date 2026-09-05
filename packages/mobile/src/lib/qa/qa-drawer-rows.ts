import * as Updates from 'expo-updates';
import { prBranchName } from './pr-branch';
import { qaSessionKey } from './qa-keys';

/**
 * Which PR the user drawer should offer to finish testing, given the branch this
 * bundle is actually running and who is signed in.
 *
 * `null` — we are on production, we do not yet know whose markers to read, or a
 * verdict has already been filed by THIS account for this exact branch + bundle;
 * in each case the drawer offers the picker instead. That last case is the
 * load-bearing one: `surfTo(config, null)` clears the pin but usually answers
 * `'nothing-to-load'` (production is not *newer* than a freshly published
 * `pr-<n>` bundle), so the tester keeps running the preview they just signed off
 * until production publishes again. The persisted marker, not a reload, is what
 * stops the drawer re-offering — exactly as it stops the launch gate re-briefing
 * (`decideQaGate`).
 *
 * A new publish on the same branch is a different `updateId`, and a different
 * signed-in account is a different `userId`, so either one re-arms both.
 *
 * `verdictSubmittedKey` is PASSED IN rather than read here so the caller can
 * subscribe to it. A screen that stays mounted across a verdict — the More tab
 * does, the drawer route does not — has to recompute when the marker lands, or
 * it keeps offering to finish testing something already signed off.
 */
export function runningQaPrNumberToOffer(
  runningPrNumber: number | null,
  userId: string | undefined,
  verdictSubmittedKey: string | null,
): number | null {
  if (runningPrNumber === null) return null;
  // No account, no answer. Falling back to the picker row is the right shape
  // anyway: the markers are account-scoped, so without an account there is
  // nothing to attribute a sign-off to, and offering "finish testing" would be
  // reading whoever used this device last.
  if (userId === undefined) return null;
  const currentKey = qaSessionKey(userId, prBranchName(runningPrNumber), Updates.updateId);
  return verdictSubmittedKey === currentKey ? null : runningPrNumber;
}
