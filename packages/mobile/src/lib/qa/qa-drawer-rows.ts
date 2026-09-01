import * as Updates from 'expo-updates';
import { getSetting } from '../../settings';
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
 */
export function runningQaPrNumberToOffer(runningPrNumber: number | null, userId: string | undefined): number | null {
  if (runningPrNumber === null) return null;
  // No account, no answer. The caller hides the whole QA group until the profile
  // resolves anyway (the rows are gated on `isTester`), so this never costs a
  // tester a row — it only stops us reading a marker we cannot attribute.
  if (userId === undefined) return null;
  const currentKey = qaSessionKey(userId, prBranchName(runningPrNumber), Updates.updateId);
  return getSetting('qaVerdictSubmittedKey') === currentKey ? null : runningPrNumber;
}
