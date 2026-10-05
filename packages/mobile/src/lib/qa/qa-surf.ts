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
import { getSetting, setSetting } from '../../settings';
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
 * The server's three possible answers to "which branches may this binary be
 * served":
 *
 * - `listed`: surfing is on; here is the list (possibly empty).
 * - `surfing-off`: the server itself says this channel does not surf (a 404
 *   carrying `xprem-branch-surfing`). Every pinned device is meant to unpin.
 * - `unavailable`: a 404 from somewhere else (a proxy, an old server) or a body
 *   of another shape. Evidence of nothing.
 */
export type QaBranchesAnswer =
  | { kind: 'listed'; list: QaBranchList }
  | { kind: 'surfing-off' }
  | { kind: 'unavailable' };

/**
 * Ask the server which branches this binary may be served. A read and nothing
 * else: it never touches the pin or a setting, so it is safe as a query
 * function. Acting on `surfing-off` is `noteBranchSurfingOff`'s job
 * (`early-updates.ts`).
 *
 * This is xprem's own `listBranches` request (same route, same four headers),
 * made here because that function folds `surfing-off` and `unavailable` into one
 * null and clears the pin itself on the first. A bare clear is not safe: see
 * `switchTrackWithoutReload` for what a device launches after one.
 *
 * `wholeList` asks for every branch (`?all=1`). The picker needs that, since it
 * has no "show the rest" tap and the server applies its newest-50 cap BEFORE
 * the `pr-<n>` filter. The early-updates check does not: that branch publishes
 * on every merge, so it is always among the newest.
 */
export async function fetchQaBranches(
  signal?: AbortSignal,
  { wholeList = true }: { wholeList?: boolean } = {},
): Promise<QaBranchesAnswer> {
  const config = requireSurfConfig();
  const response = await fetch(`${config.baseUrl}/branch_lists${wholeList ? '?all=1' : ''}`, {
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
    return response.headers.get(SURFING_DISABLED_HEADER) === null ? { kind: 'unavailable' } : { kind: 'surfing-off' };
  }
  if (!response.ok) throw new Error(`Could not reach the update server (${response.status}).`);

  // This build outlives the server it was written against, so a body of another
  // shape reads as "no list" instead of crashing the screen that asked.
  const page: unknown = await response.json();
  if (typeof page !== 'object' || page === null) return { kind: 'unavailable' };
  const { branches } = page as Record<string, unknown>;
  if (!Array.isArray(branches)) return { kind: 'unavailable' };

  const previews: QaPrBranch[] = [];
  let staging: QaBranchList['staging'] = null;
  let earlyUpdates: QaBranchList['earlyUpdates'] = null;
  for (const branch of branches.filter(isServerBranch)) {
    const kind = otaBranchKind(branch.name);
    if (kind === 'staging') staging = { lastUpdateAt: branch.lastUpdateAt };
    if (kind === 'early-updates') earlyUpdates = { lastUpdateAt: branch.lastUpdateAt };
    const prNumber = parsePrBranch(branch.name);
    if (prNumber === null) continue;
    previews.push({ prNumber, branch: branch.name, lastUpdateAt: branch.lastUpdateAt });
  }
  previews.sort((left, right) => branchTimeMs(right.lastUpdateAt) - branchTimeMs(left.lastUpdateAt));
  return { kind: 'listed', list: { previews, staging, earlyUpdates } };
}

/** PRs plus the staged and early-updates branches, or null when there is no list. */
export async function listQaBranches(signal?: AbortSignal): Promise<QaBranchList | null> {
  const answer = await fetchQaBranches(signal);
  return answer.kind === 'listed' ? answer.list : null;
}

// ---------------------------------------------------------------------------
// The branch pin
//
// THE RULE EVERYTHING BELOW EXISTS FOR. expo-updates stamps each update it
// downloads with the request headers in force at that moment, and at a cold
// start it will only launch an update whose stamp EQUALS the headers configured
// now (`LauncherSelectionPolicyFilterAware`: `update.requestHeaders ==
// config.requestHeaders`). An update id already on disk is never restamped
// (`AppLoader`: an existing `StatusReady` row is returned as is). The embedded
// bundle carries the build's own headers, so it only launches with no override.
//
// So writing the header override is not "follow that branch from the next
// launch". It is "at the next launch, refuse everything on disk that was not
// downloaded under exactly these headers". If nothing was, the launch blocks the
// splash screen on a download, and offline it emergency-launches the embedded
// bundle. Hence: a pin is only ever KEPT once an update stamped for it is on
// disk, and a failed switch puts the previous pin back.
// ---------------------------------------------------------------------------

/**
 * The header set for a branch, built the way xprem's `applyBranchHeader` builds
 * it, because the override replaces the whole set: every declared header that
 * has a value, then the running channel and app id, then the branch. Empty
 * values are dropped on purpose. expo-updates applies this set last and each
 * entry replaces what the server stored, so an empty `xprem-surf-blocked` would
 * wipe the crashed-update verdicts on every poll.
 *
 * It must also be the SAME set every time for a given branch: the stamp
 * comparison above is on the whole map, so a pin rewritten with one header
 * different orphans every update downloaded under the old one.
 */
function headersForBranch(config: SurfConfig, branch: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(config.requestHeaders)) {
    if (typeof value === 'string' && value !== '') headers[key] = value;
  }
  headers['expo-channel-name'] = config.channel;
  headers['expo-app-id'] = config.appId;
  headers[BRANCH_HEADER] = branch;
  return headers;
}

/** Write the override for a branch; null is no override at all (the build's own headers). */
function writePin(config: SurfConfig, branch: string | null): void {
  Updates.setUpdateRequestHeadersOverride(branch === null ? null : headersForBranch(config, branch));
}

/**
 * The branch this app last pinned and believes is still pinned: the override
 * itself cannot be read back from expo-updates. Null is the build's own
 * channel. For the early-updates branch it additionally means an update stamped
 * for that pin is on disk, because `switchTrackWithoutReload` only records it
 * then.
 *
 * It is also who OWNS the header. A `pr-<n>` or staging value is a tester's
 * choice, and nothing about early updates may overwrite it.
 */
export function readOtaPinnedBranch(): string | null {
  return getSetting('otaPinnedBranch');
}

/**
 * Record a pin this app did not write this session: the bundle running at
 * launch proves which pin was in force, since only an update stamped for the
 * configured headers can launch. Covers a phone pinned before the record
 * existed, and one killed between the header write and the record.
 */
export function adoptRunningOtaPin(): void {
  const runningBranch = readRunningOtaBranch();
  if (otaBranchKind(runningBranch) === 'default' || readOtaPinnedBranch() === runningBranch) return;
  setSetting('otaPinnedBranch', runningBranch);
}

// One pin change at a time, across everything that makes one: a tester's surf,
// the early-updates sync at launch, the switch in More. Two interleaved would
// stamp a download with the other one's headers, or record a pin that the other
// had just replaced.
let pinChangeQueue: Promise<unknown> = Promise.resolve();

/**
 * Run a task that changes the pin after every earlier one has settled. The
 * surfs below queue themselves; `joinEarlyUpdatesTrack` and
 * `leaveForProductionTrack` do not, so a caller can decide and act inside one
 * turn. Never call a surf from inside a task: it would wait on itself.
 */
export function runPinChangeExclusively<Result>(task: () => Promise<Result>): Promise<Result> {
  const run = pinChangeQueue.then(task, task);
  pinChangeQueue = run.catch(() => undefined);
  return run;
}

/**
 * Run one of xprem's surfs (pin, check, download, RELOAD) with the pin record
 * kept true around it.
 *
 * The record is written first, because a surf that reloads never returns to
 * write it. When the surf rejects, xprem has already "restored" the pin from its
 * own session memory, which knows nothing of a pin written by an earlier session
 * or by `switchTrackWithoutReload`. Two ways that goes wrong, both closed by
 * writing our own record back over it:
 *
 * - a member pinned at launch, then a failed PR surf: xprem restores "nothing",
 *   leaving the member unpinned while the switch says on;
 * - a PR surf that loaded nothing, then a return to early updates, then a failed
 *   surf: xprem restores the PR pin the tester had already left.
 */
async function surfOwningPin(branch: string | null): Promise<SurfOutcome> {
  const config = requireSurfConfig();
  const pinnedBefore = readOtaPinnedBranch();
  setSetting('otaPinnedBranch', branch);
  try {
    return await surfTo(config, branch);
  } catch (error) {
    setSetting('otaPinnedBranch', pinnedBefore);
    writePin(config, pinnedBefore);
    throw error;
  }
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
  return runPinChangeExclusively(() => surfOwningPin(prBranchName(prNumber)));
}

/** Clear the branch pin, go back to the build's own channel and reload onto it. */
export async function surfToProduction(): Promise<SurfOutcome> {
  return runPinChangeExclusively(() => surfOwningPin(null));
}

/** Pin the tester-only staged main bundle; production is never remapped. */
export async function surfToStaging(): Promise<SurfOutcome> {
  return runPinChangeExclusively(() => surfOwningPin(STAGING_OTA_BRANCH));
}

export function readRunningOtaBranch(): string | null {
  return readOtaBranch(Updates.manifest);
}

/** The embedded bundle was launched because nothing on disk could be. */
export function readIsEmergencyLaunch(): boolean {
  return Updates.isEmergencyLaunch;
}

// What this session knows about the stamp on updates already on disk, keyed by
// update id. The pin in force at launch stamps the running update and anything
// the launch-time background check downloaded; `switchTrackWithoutReload` adds
// its own downloads. Read once, at module load: by the time anything switches,
// the record may already describe a different pin.
const pinAtLaunch: string | null = readPinAtLaunch();

function readPinAtLaunch(): string | null {
  // The embedded bundle only launches under the build's own headers, or as an
  // emergency launch, where nothing on disk matched the pin at all.
  if (Updates.isEmbeddedLaunch) return null;
  // A preview, staging or early-updates bundle names its own pin, and is right
  // even where the record is missing (`adoptRunningOtaPin`).
  const runningBranch = readOtaBranch(Updates.manifest);
  return otaBranchKind(runningBranch) === 'default' ? getSetting('otaPinnedBranch') : runningBranch;
}
const stampedThisSession = new Map<string, string | null>();

/** The pin an update on disk was downloaded under, or undefined when it is not known to be on disk. */
function knownStamp(updateId: string): string | null | undefined {
  if (stampedThisSession.has(updateId)) return stampedThisSession.get(updateId);
  if (updateId === Updates.updateId) return pinAtLaunch;
  // Downloaded by the launch-time check, waiting for the next cold start.
  if (updateId === Updates.latestContext.downloadedManifest?.id) return pinAtLaunch;
  return undefined;
}

/** Test seam: forget what earlier cases downloaded. */
export function resetOtaPinSessionForTests(): void {
  stampedThisSession.clear();
}

/**
 * - `switched`: the pin is written and an update stamped for it is on disk, so
 *   the next cold start launches that update.
 * - `nothing-to-launch`: the server had no update that would be launchable under
 *   the new pin, so the previous pin was put back and nothing changed.
 */
export type TrackSwitchOutcome = 'switched' | 'nothing-to-launch';

/**
 * Move this device to another branch for the NEXT launch, with no reload: write
 * the pin, check, download, and keep the pin only when the download left an
 * update stamped for it on disk. The running session is never restarted, so this
 * is safe with a queue running and a board connected.
 *
 * Anything short of that puts the previous pin back and changes nothing:
 * a thrown check or download (offline), a server with nothing to serve, or the
 * one answer that looks like success and is not, an update id that is already
 * on disk under a DIFFERENT stamp. expo-updates reports that as downloaded and
 * does not restamp it, so it could never launch under the new pin. That is what
 * the server sends when it does not have the branch for this binary: it falls
 * back to the channel's own update, which is usually the one running.
 *
 * The one window this cannot close: the app killed between the header write and
 * the restore. `adoptRunningOtaPin` and the launch sync repair that on the next
 * launch, but that launch itself has nothing stamped to start from.
 */
async function switchTrackWithoutReload(target: string | null): Promise<TrackSwitchOutcome> {
  const config = requireSurfConfig();
  const pinnedBefore = readOtaPinnedBranch();
  writePin(config, target);
  try {
    const check = await Updates.checkForUpdateAsync();
    let launchable: boolean;
    if (check.isAvailable) {
      const stamp = knownStamp(check.manifest.id);
      if (stamp === undefined) {
        const fetched = await Updates.fetchUpdateAsync();
        launchable = fetched.isNew;
        if (fetched.isNew) stampedThisSession.set(fetched.manifest.id, target);
      } else {
        launchable = stamp === target;
      }
    } else if (
      target === null &&
      check.reason === Updates.UpdateCheckResultNotAvailableReason.NO_UPDATE_AVAILABLE_ON_SERVER
    ) {
      // The build's own channel has published nothing for this binary, so the
      // embedded bundle IS that channel, and it always launches with no pin.
      launchable = true;
    } else {
      // Nothing newer than the bundle running. Fine when that bundle was itself
      // downloaded under this pin (leaving straight after joining, say); not
      // when it was not, because then nothing on disk can launch.
      launchable = Updates.updateId !== null && knownStamp(Updates.updateId) === target;
    }
    if (!launchable) {
      writePin(config, pinnedBefore);
      return 'nothing-to-launch';
    }
    setSetting('otaPinnedBranch', target);
    return 'switched';
  } catch (error) {
    writePin(config, pinnedBefore);
    throw error;
  }
}

/**
 * Follow the early-updates branch from the next launch. See
 * `switchTrackWithoutReload`. Call inside `runPinChangeExclusively`.
 */
export async function joinEarlyUpdatesTrack(): Promise<TrackSwitchOutcome> {
  return switchTrackWithoutReload(EARLY_UPDATES_OTA_BRANCH);
}

/**
 * Follow the build's own channel from the next launch. See
 * `switchTrackWithoutReload`. Call inside `runPinChangeExclusively`.
 */
export async function leaveForProductionTrack(): Promise<TrackSwitchOutcome> {
  return switchTrackWithoutReload(null);
}
