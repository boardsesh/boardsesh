import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { Platform } from 'react-native';
// The ONLY module in the app allowed to reach into xprem's internals. The
// published package exports just <ControlCenter />, openControlCenter and the
// SurfableBranch type, but it ships its TypeScript sources with `main:
// src/index.ts` and no `exports` map, so these two modules resolve as plain deep
// paths. Keeping every such import here means one file to fix if xprem ever
// publishes a real entry point for them.
import { surfTo, type SurfOutcome } from '@xprem/control-center/src/surf';
import { BRANCH_HEADER, readConfig, readLoadedState, type SurfConfig } from '@xprem/control-center/src/config';
import { isBranchSurfingBuild } from '../legacy-ota-channel-migration';
import { readOtaBranch } from '../ota-telemetry';
import { setSetting } from '../../settings';
import { parsePrBranch, prBranchName } from './pr-branch';

export type { SurfOutcome };

/** One `pr-<n>` branch this build could be served, with how fresh it is. */
export type QaPrBranch = {
  prNumber: number;
  branch: string;
  /** ISO 8601 — when the branch last received a publish. */
  lastUpdateAt: string;
};

// Fits the production channel's existing `pr-*` branch-surfing pattern while
// remaining distinct from numbered PR previews.
export const STAGING_OTA_BRANCH = 'pr-staging';
// The "Get updates early" track: every merge to main, ahead of the daily stable
// release. Named to fit the same `pr-*` surfing pattern, and like staging it is
// NOT a pull request. Every place that lists or classifies branches has to say
// so explicitly, because the numbered-PR pattern already drops it silently.
export const EARLY_UPDATES_OTA_BRANCH = 'pr-beta';

export type QaBranchList = {
  previews: QaPrBranch[];
  staging: { lastUpdateAt: string } | null;
  /** Set when the server has an early update this binary can run. */
  earlyUpdates: { lastUpdateAt: string } | null;
};

/**
 * What kind of branch a bundle came from. `'default'` is the build's own
 * channel (xprem reports no branch for it) plus anything this app does not
 * publish on purpose.
 */
export type OtaBranchKind = 'default' | 'preview' | 'staging' | 'early-updates';

export function otaBranchKind(branch: string | null): OtaBranchKind {
  if (branch === EARLY_UPDATES_OTA_BRANCH) return 'early-updates';
  if (branch === STAGING_OTA_BRANCH) return 'staging';
  return parsePrBranch(branch) === null ? 'default' : 'preview';
}

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
  const result = await listQaBranches(signal);
  return result?.previews ?? null;
}

/** Set by the server on a 404 it decided, so a proxy's 404 is not mistaken for one. */
const SURFING_DISABLED_HEADER = 'xprem-branch-surfing';

type ServerBranch = { name: string; lastUpdateAt: string };

function isServerBranch(entry: unknown): entry is ServerBranch {
  if (typeof entry !== 'object' || entry === null) return false;
  const { name, lastUpdateAt } = entry as Record<string, unknown>;
  return typeof name === 'string' && typeof lastUpdateAt === 'string';
}

/**
 * Every branch the server would serve this binary, or null when it has no list
 * for this channel.
 *
 * This is xprem's own `listBranches` request (same route, same four headers,
 * the whole list instead of its newest-50 page), made here because that function
 * folds two different answers into one null: "surfing is switched off", which it
 * acts on by clearing the branch pin, and "that 404 came from somewhere else",
 * which it ignores. Early-updates membership has to follow the first and survive
 * the second. Left on after the server switched surfing off, the launch re-pin
 * would put back the pin the server had just asked every device to drop.
 */
async function fetchServerBranches(config: SurfConfig, signal?: AbortSignal): Promise<ServerBranch[] | null> {
  const response = await fetch(`${config.baseUrl}/branch_lists?all=1`, {
    method: 'GET',
    headers: {
      'expo-app-id': config.appId,
      'expo-channel-name': config.channel,
      'expo-runtime-version': config.runtimeVersion,
      // Per platform, like the manifest: a branch whose only update is for the
      // other one cannot be served here, so it must not be offered.
      'expo-platform': Platform.OS,
    },
    signal,
  });
  if (response.status === 404) {
    if (response.headers.get(SURFING_DISABLED_HEADER) !== null) {
      Updates.setUpdateRequestHeadersOverride(null);
      setSetting('earlyUpdates', false);
    }
    return null;
  }
  if (!response.ok) throw new Error(`Could not reach the update server (${response.status}).`);

  // This build outlives the server it was written against, so a body of another
  // shape reads as "no list" instead of crashing the screen that asked.
  const page: unknown = await response.json();
  if (typeof page !== 'object' || page === null) return null;
  const { branches } = page as Record<string, unknown>;
  return Array.isArray(branches) ? branches.filter(isServerBranch) : null;
}

/** PRs plus the staged and early-updates branches, from one server request. */
export async function listQaBranches(signal?: AbortSignal): Promise<QaBranchList | null> {
  const branches = await fetchServerBranches(requireSurfConfig(), signal);
  if (branches === null) return null;

  const previews: QaPrBranch[] = [];
  let staging: QaBranchList['staging'] = null;
  let earlyUpdates: QaBranchList['earlyUpdates'] = null;
  for (const branch of branches) {
    const kind = otaBranchKind(branch.name);
    if (kind === 'staging') staging = { lastUpdateAt: branch.lastUpdateAt };
    if (kind === 'early-updates') earlyUpdates = { lastUpdateAt: branch.lastUpdateAt };
    const prNumber = parsePrBranch(branch.name);
    if (prNumber === null) continue;
    previews.push({ prNumber, branch: branch.name, lastUpdateAt: branch.lastUpdateAt });
  }
  previews.sort((left, right) => branchTimeMs(right.lastUpdateAt) - branchTimeMs(left.lastUpdateAt));
  return { previews, staging, earlyUpdates };
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

/** Pin the tester-only staged main bundle; production is never remapped. */
export async function surfToStaging(): Promise<SurfOutcome> {
  return surfTo(requireSurfConfig(), STAGING_OTA_BRANCH);
}

export function readRunningOtaBranch(): string | null {
  return readOtaBranch(Updates.manifest);
}

/**
 * Point this device's update requests at the early-updates branch. Nothing
 * else: no update check, no download, no reload, no network. The branch
 * arrives the next time the app opens, so this is safe with a queue running
 * and a board connected, and it works offline.
 *
 * Deliberately not `surfTo`. That checks for an update straight away, and when
 * the check fails it restores the pin it remembers from THIS session. A fresh
 * session remembers nothing, so an offline cold start would end with no pin at
 * all.
 *
 * The header set is rebuilt the way xprem's `applyBranchHeader` builds it,
 * because the override replaces the whole set: every declared header that has
 * a value, then the running channel and app id, then the branch. Empty values
 * are dropped on purpose. expo-updates applies this set last and each entry
 * replaces what the server stored, so an empty `xprem-surf-blocked` would wipe
 * the crashed-update verdicts on every poll.
 */
export function pinEarlyUpdates(): void {
  const config = requireSurfConfig();
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(config.requestHeaders)) {
    if (typeof value === 'string' && value !== '') headers[key] = value;
  }
  headers['expo-channel-name'] = config.channel;
  headers['expo-app-id'] = config.appId;
  headers[BRANCH_HEADER] = EARLY_UPDATES_OTA_BRANCH;
  Updates.setUpdateRequestHeadersOverride(headers);
}

/**
 * Drop the branch pin with no check and no reload: the native side goes back
 * to the headers baked into the build. The regular track's next update loads
 * once it is newer than the bundle already running.
 */
export function clearOtaBranchPin(): void {
  requireSurfConfig();
  Updates.setUpdateRequestHeadersOverride(null);
}
