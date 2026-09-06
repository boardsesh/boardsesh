import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
// The ONLY module in the app allowed to reach into xprem's internals. The
// published package exports just <ControlCenter />, openControlCenter and the
// SurfableBranch type, but it ships its TypeScript sources with `main:
// src/index.ts` and no `exports` map, so these two modules resolve as plain deep
// paths. Keeping every such import here means one file to fix if xprem ever
// publishes a real entry point for them.
import { listBranches, surfTo, type SurfOutcome } from '@xprem/control-center/src/surf';
import { readConfig, readLoadedState, type SurfConfig } from '@xprem/control-center/src/config';
import { isBranchSurfingBuild } from '../legacy-ota-channel-migration';
import { readOtaBranch } from '../ota-telemetry';
import { parsePrBranch, prBranchName } from './pr-branch';

export type { SurfOutcome };

/** One `pr-<n>` branch this build could be served, with how fresh it is. */
export type QaPrBranch = {
  prNumber: number;
  branch: string;
  /** ISO 8601 — when the branch last received a publish. */
  lastUpdateAt: string;
};

export const BRANCH_SURFING_UNAVAILABLE_MESSAGE = 'Branch surfing is unavailable on this build';

/**
 * Whether the binary itself can surf, before asking xprem to build a config.
 * Checked first on purpose: `readConfig()` console.warns loudly about missing
 * build-time headers, which is right for a build that was MEANT to surf and
 * pure noise on a dev client or an old binary that was never going to.
 *
 * The dev / updates-disabled cases are folded into `isBranchSurfingBuild` rather
 * than repeated as a bare `if (__DEV__)`: Metro and Vitest both substitute
 * `__DEV__` textually, so a literal check here would be constant-folded and this
 * branch could never be exercised by a test.
 */
function isSurfCapableBinary(): boolean {
  return isBranchSurfingBuild({
    development: __DEV__,
    updatesEnabled: Updates.isEnabled,
    updatesConfig: Constants.expoConfig?.updates,
  });
}

/** True when this build can list and load `pr-<n>` branches. */
export function qaSurfingAvailable(): boolean {
  return isSurfCapableBinary() && readConfig() !== null;
}

function requireSurfConfig(): SurfConfig {
  const config = isSurfCapableBinary() ? readConfig() : null;
  if (config === null) throw new Error(BRANCH_SURFING_UNAVAILABLE_MESSAGE);
  return config;
}

/** The PR whose preview this bundle is, or null on production. */
export function readRunningPrNumber(): number | null {
  return parsePrBranch(readOtaBranch(Updates.manifest));
}

/**
 * The PR whose preview the server refused to serve here because it crashed on
 * launch. Surfaced in the pick list so a tester can see why a branch they chose
 * did not stick — that is a finding, not a glitch.
 */
export function readRefusedPrNumber(): number | null {
  return parsePrBranch(readLoadedState().refusedBranch);
}

// Date.parse yields NaN for anything unparseable, and NaN in a comparator makes
// the sort order undefined — so an odd timestamp sinks to the bottom instead of
// scrambling the list.
function branchTimeMs(lastUpdateAt: string): number {
  const parsed = Date.parse(lastUpdateAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The `pr-<n>` branches this build could load, freshest first. Returns null when
 * branch surfing is switched off for this channel — distinct from an empty array,
 * which means surfing is on but nothing is published for this runtime version.
 * Throws when the update server is unreachable; the caller decides whether that
 * is worth telling the tester about.
 *
 * Asks for the WHOLE list, not xprem's default newest-50 page. That default is
 * sized for its own control panel, which offers a "show the rest" tap; this
 * screen has no such affordance, so the page cap read as "these are the PRs
 * with a preview" while quietly hiding the rest. Worse, the cap is applied by
 * the server BEFORE the `pr-<n>` filter below, so any other branch published
 * for this runtime version spent one of the fifty.
 */
export async function listPrBranches(signal?: AbortSignal): Promise<QaPrBranch[] | null> {
  const page = await listBranches(requireSurfConfig(), signal, true);
  if (page === null) return null;

  const previews: QaPrBranch[] = [];
  for (const branch of page.branches) {
    const prNumber = parsePrBranch(branch.name);
    if (prNumber === null) continue;
    previews.push({ prNumber, branch: branch.name, lastUpdateAt: branch.lastUpdateAt });
  }
  previews.sort((left, right) => branchTimeMs(right.lastUpdateAt) - branchTimeMs(left.lastUpdateAt));
  return previews;
}

/**
 * Point this device at a PR's preview and reload onto it. `'reloading'` means
 * the app is restarting and nothing after the call will run; `'nothing-to-load'`
 * means the pin is in place but the server had nothing newer to serve, so the
 * branch arrives on a later relaunch.
 */
// async, not a plain `return surfTo(...)`: requireSurfConfig throws, and a
// synchronous throw out of a Promise-returning function is a trap for every
// caller that only wrote a .catch().
export async function surfToPr(prNumber: number): Promise<SurfOutcome> {
  return surfTo(requireSurfConfig(), prBranchName(prNumber));
}

/**
 * Clear the branch pin and go back to the build's own channel. Usually answers
 * `'nothing-to-load'`: production is not *newer* than a freshly published
 * `pr-<n>` bundle, so the running JS stays until production publishes again.
 * The pin is gone either way — which is what actually matters.
 */
export async function surfToProduction(): Promise<SurfOutcome> {
  return surfTo(requireSurfConfig(), null);
}
