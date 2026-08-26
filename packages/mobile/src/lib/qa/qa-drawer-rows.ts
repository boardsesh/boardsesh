import * as Updates from 'expo-updates';
import { getSetting } from '../../settings';
import { prBranchName } from './pr-branch';
import { qaSessionKey } from './qa-keys';

/**
 * Which PR the user drawer should offer to finish testing, given the branch this
 * bundle is actually running.
 *
 * `null` — either we are on production, or a verdict has already been filed for
 * this exact branch + bundle, in which case the drawer offers the picker instead.
 * That second case is the load-bearing one: `surfTo(config, null)` clears the
 * pin but usually answers `'nothing-to-load'` (production is not *newer* than a
 * freshly published `pr-<n>` bundle), so the tester keeps running the preview
 * they just signed off until production publishes again. The persisted marker,
 * not a reload, is what stops the drawer re-offering — exactly as it stops the
 * launch gate re-briefing (`decideQaGate`).
 *
 * A new publish on the same branch is a different `updateId`, so it re-arms both.
 */
export function runningQaPrNumberToOffer(runningPrNumber: number | null): number | null {
  if (runningPrNumber === null) return null;
  const currentKey = qaSessionKey(prBranchName(runningPrNumber), Updates.updateId);
  return getSetting('qaVerdictSubmittedKey') === currentKey ? null : runningPrNumber;
}
