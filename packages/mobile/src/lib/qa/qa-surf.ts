import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { Platform } from 'react-native';
// The ONLY module in the app allowed to reach into xprem's internals. The
// published package exports just <ControlCenter />, openControlCenter and the
// SurfableBranch type, but it ships its TypeScript sources with `main:
// src/index.ts` and no `exports` map, so these two modules resolve as plain deep
// paths. Keeping every such import here means one file to fix if xprem ever
// publishes a real entry point for them.
import type { SurfOutcome } from '@xprem/control-center/src/surf';
import { BRANCH_HEADER, readConfig, readLoadedState, type SurfConfig } from '@xprem/control-center/src/config';
import { isBranchSurfingBuild } from '../ota-channel-override-cleanup';
import { readOtaBranch } from '../ota-telemetry';
import { getSetting, setSetting } from '../../settings';
import {
  runOtaOperation,
  readOtaHeaderRevision,
  noteOtaHeadersChanged,
  resetOtaOperationOwnerForTests,
  type OtaOperationLease,
} from '../ota-operation-owner';
import {
  EARLY_UPDATES_OTA_BRANCH,
  STAGING_OTA_BRANCH,
  otaBranchKind,
  parsePrBranch,
  prBranchName,
  type OtaBranchKind,
} from './pr-branch';

// The branch names and their classifier are pure and live in pr-branch.ts, so
// code that only needs to CLASSIFY a branch does not load xprem and
// expo-updates to do it. Re-exported because this is where everything that
// pins a branch already looks for them.
export { EARLY_UPDATES_OTA_BRANCH, STAGING_OTA_BRANCH, otaBranchKind, type OtaBranchKind };

export type { SurfOutcome };

/** One `pr-<n>` branch this build could be served, with how fresh it is. */
export type QaPrBranch = {
  prNumber: number;
  branch: string;
  /** ISO 8601 — when the branch last received a publish. */
  lastUpdateAt: string;
};

export type QaBranchList = {
  previews: QaPrBranch[];
  staging: { lastUpdateAt: string } | null;
  /** Set when the server has an early update this binary can run. */
  earlyUpdates: { lastUpdateAt: string } | null;
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
 * Asks for the WHOLE list (`?all=1`), not xprem's default newest-50 page. That
 * default is sized for its own control panel, which offers a "show the rest"
 * tap. Nothing here does, and the server applies the cap BEFORE the `pr-<n>`
 * filter, so the page read as "these are the PRs with a preview" while hiding
 * the rest. The early-updates check needs the whole list as well: fifty PR
 * pushes between two merges to main push that branch off the first page.
 */
async function readQaBranches(signal: AbortSignal): Promise<QaBranchesAnswer> {
  const config = requireSurfConfig();
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
    return response.headers.get(SURFING_DISABLED_HEADER) === null ? { kind: 'unavailable' } : { kind: 'surfing-off' };
  }
  if (!response.ok) throw new Error(`Could not reach the update server (${response.status}).`);

  // This build outlives the server it was written against, so a body of another
  // shape reads as "no list" instead of crashing the screen that asked.
  const page: unknown = await response.json();
  if (signal.aborted) throw new Error('The update server took too long.');
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

/** The timeout covers the response body too; fetch abort alone cannot bound a stalled body. */
export async function fetchQaBranches(signal?: AbortSignal): Promise<QaBranchesAnswer> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, 30_000);
  let removeAbort = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    const rejectAbort = () => reject(new Error('The update server request was cancelled or took too long.'));
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
    removeAbort = () => controller.signal.removeEventListener('abort', rejectAbort);
    if (controller.signal.aborted) rejectAbort();
  });
  try {
    if (controller.signal.aborted) return await cancelled;
    return await Promise.race([readQaBranches(controller.signal), cancelled]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    removeAbort();
  }
}

// ---------------------------------------------------------------------------
// The branch pin
//
// THE RULE EVERYTHING BELOW EXISTS FOR. expo-updates stamps each update it
// downloads with the request headers in force at that moment, and at a cold
// start it will only launch an update whose stamp EQUALS the headers configured
// now (`LauncherSelectionPolicyFilterAware`, both platforms: `update.requestHeaders
// == config.requestHeaders`). An update id already on disk is never restamped
// (iOS `AppLoader`, Android `Loader.processUpdate`: an existing ready row is
// returned as is, and `fetchUpdateAsync` still reports `isNew: true` for it).
//
// So writing the header override is not "follow that branch from the next
// launch". It is "at the next launch, refuse everything on disk that was not
// downloaded under exactly these headers". Hence: a pin is only ever KEPT once
// an update stamped for it is on disk, and a failed switch puts the previous pin
// back.
//
// THE EMBEDDED BUNDLE DIFFERS BY PLATFORM, and it decides what "nothing on disk
// matches" costs:
//
// - Android inserts the embedded row with the headers BAKED into the build
//   (`EmbeddedUpdate.kt`) and never reaps it (`ReaperSelectionPolicyFilterAware.kt`).
//   It is always launchable with no pin and never launchable under one.
// - iOS inserts it with the headers in force AT INSERTION
//   (`UpdatesDatabase.addUpdate` writes `config.requestHeaders`), only when
//   nothing else is launchable or it is newer, and reaps it like any other row
//   (`ReaperSelectionPolicyFilterAware.swift`). So it may carry a pin's stamp
//   (inserted on the first launch after a store update while pinned), a baked
//   stamp, or be gone.
//
// With nothing launchable: Android blocks the splash on a download and offline
// emergency-launches. iOS first inserts the embedded row under the current
// headers if it is not on disk and launches that, normally.
// ---------------------------------------------------------------------------

/** A pin: the branch name, or null for the build's own (baked) headers. */
type Pin = string | null;

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

export function readRunningOtaBranch(): string | null {
  return readOtaBranch(Updates.manifest);
}

/** The embedded bundle was launched because nothing on disk could be. */
export function readIsEmergencyLaunch(): boolean {
  return Updates.isEmergencyLaunch;
}

export function readRunningUpdateId(): string | null {
  return Updates.updateId;
}

/**
 * The pin the running bundle was launched under, which is also its stamp: only
 * an update stamped for the configured headers launches. Undefined after an
 * emergency launch, where nothing matched and so nothing is proven.
 *
 * Read ONCE, at module load. Every later answer would be about a session that
 * has already switched.
 */
const launchPin: Pin | undefined = readLaunchPin();

function readLaunchPin(): Pin | undefined {
  if (Updates.isEmergencyLaunch) return undefined;
  // A preview, staging or early-updates bundle names its own pin.
  const runningBranch = readOtaBranch(Updates.manifest);
  if (otaBranchKind(runningBranch) !== 'default') return runningBranch;
  // A switch the app was killed in the middle of: the override was written and
  // never restored, and this launch succeeded under it.
  const interrupted = getSetting('otaPinSwitchInFlight');
  if (interrupted !== null) return interrupted.to;
  // Android's embedded row always carries the baked headers. iOS's may carry a
  // pin's, so there the record has to answer.
  if (Platform.OS === 'android' && Updates.isEmbeddedLaunch) return null;
  return getSetting('otaPinnedBranch');
}

// Updates this session downloaded, and the pin each was downloaded under.
const stampedThisSession = new Map<string, Pin | undefined>();
const rollbackStamps = new Map<string, Pin | undefined>();
let configuredHeaderIdentity: Pin = launchPin !== undefined ? launchPin : getSetting('otaPinnedBranch');
let emergencyPinEvidence = false;
let pendingOwnedRollback: { pin: Pin; headerRevision: number; previousCommitTime: string | undefined } | undefined;

/** Test seam: forget what earlier cases downloaded. */
export function resetOtaPinSessionForTests(): void {
  stampedThisSession.clear();
  rollbackStamps.clear();
  configuredHeaderIdentity = getSetting('otaPinnedBranch');
  emergencyPinEvidence = false;
  pendingOwnedRollback = undefined;
  resetOtaOperationOwnerForTests();
}

/** Write the override for a branch; null is no override at all (the build's own headers). */
function writePin(config: SurfConfig, pin: Pin): void {
  setOwnedOtaHeaders(pin === null ? null : headersForBranch(config, pin), pin);
}

type DiskKnowledge = { onDisk: false } | { onDisk: true; stamp: Pin | undefined };

/** The update expo-updates has downloaded and is holding for the next cold start, if any. */
function readPendingUpdateId(): string | undefined {
  return Updates.latestContext.downloadedManifest?.id;
}

/**
 * What this session knows about an update id: whether it is on disk, and under
 * which pin. `pendingUpdateId` is the pending download to judge by, always
 * passed explicitly: a caller that has just downloaded must pass the one from
 * BEFORE its download, since afterwards the pending update is its own.
 */
function knownOnDisk(updateId: string, pendingUpdateId: string | undefined): DiskKnowledge {
  if (stampedThisSession.has(updateId)) return { onDisk: true, stamp: stampedThisSession.get(updateId) };
  if (updateId === Updates.updateId) return { onDisk: true, stamp: launchPin };
  // Downloaded by the launch-time check, waiting for the next cold start.
  if (updateId === pendingUpdateId) {
    return { onDisk: true, stamp: readOtaHeaderRevision() === 0 ? launchPin : undefined };
  }
  return { onDisk: false };
}

function rememberPendingUpdate(): void {
  const pendingId = readPendingUpdateId();
  if (pendingId && !stampedThisSession.has(pendingId)) {
    const pendingKnowledge = knownOnDisk(pendingId, pendingId);
    stampedThisSession.set(pendingId, pendingKnowledge.onDisk ? pendingKnowledge.stamp : undefined);
  }
  const rollback = Updates.latestContext.rollback;
  if (rollback && !rollbackStamps.has(rollback.commitTime)) {
    const owned = pendingOwnedRollback;
    const ownedStamp =
      owned && owned.headerRevision === readOtaHeaderRevision() && owned.previousCommitTime !== rollback.commitTime
        ? owned.pin
        : undefined;
    rollbackStamps.set(rollback.commitTime, readOtaHeaderRevision() === 0 ? launchPin : ownedStamp);
  }
}

/**
 * Write inside an owned, idle turn. Branches use their pin as identity; legacy
 * EAS targets use `channel:<name>`, distinct from every supported branch pin.
 * Remember existing pending stamps before replacing the whole native header set.
 */
export function setOwnedOtaHeaders(headers: Record<string, string> | null, identity: string | null): void {
  rememberPendingUpdate();
  Updates.setUpdateRequestHeadersOverride(headers);
  configuredHeaderIdentity = identity;
  pendingOwnedRollback = undefined;
  noteOtaHeadersChanged();
}

export function clearOwnedOtaHeaders(): void {
  setOwnedOtaHeaders(null, null);
}

/** Raw native adapter; call through lease.native so held headers cannot change. */
export async function fetchOwnedOtaUpdate(): Promise<Updates.UpdateFetchResult> {
  rememberPendingUpdate();
  const knownBefore = new Set(stampedThisSession.keys());
  if (Updates.updateId) knownBefore.add(Updates.updateId);
  const pendingBefore = readPendingUpdateId();
  if (pendingBefore) knownBefore.add(pendingBefore);
  const rollbackBefore = Updates.latestContext.rollback?.commitTime;
  const heldPin = configuredHeaderIdentity;
  pendingOwnedRollback = undefined;
  try {
    const fetched = await Updates.fetchUpdateAsync();
    if (fetched.isRollBackToEmbedded) {
      pendingOwnedRollback = {
        pin: heldPin,
        headerRevision: readOtaHeaderRevision(),
        previousCommitTime: rollbackBefore,
      };
    }
    if (fetched.isNew && !knownBefore.has(fetched.manifest.id)) {
      stampedThisSession.set(fetched.manifest.id, heldPin);
    }
    return fetched;
  } finally {
    // State events may report the download before a native rejection reaches
    // JS. Its provenance still belongs to this operation, even after timeout.
    const pendingAfter = readPendingUpdateId();
    if (pendingAfter && !knownBefore.has(pendingAfter)) stampedThisSession.set(pendingAfter, heldPin);
    const rollbackAfter = Updates.latestContext.rollback?.commitTime;
    if (rollbackAfter && rollbackAfter !== rollbackBefore && !rollbackStamps.has(rollbackAfter)) {
      rollbackStamps.set(rollbackAfter, heldPin);
    }
  }
}

export type OtaReloadReceipt = {
  headerRevision: number;
  /** Held-header identity: branch pin, legacy `channel:<name>`, or baked headers. */
  pin: Pin;
  target: { kind: 'update'; id: string } | { kind: 'rollback'; commitTime: string };
};

/** Unknown or differently stamped pending data must never be a reload fallback. */
export function captureOtaReloadReceipt(): OtaReloadReceipt | null {
  rememberPendingUpdate();
  if (Updates.latestContext.isUpdatePending === false) return null;
  const pendingId = readPendingUpdateId();
  if (pendingId) {
    if (!stampedThisSession.has(pendingId) || stampedThisSession.get(pendingId) !== configuredHeaderIdentity)
      return null;
    return {
      headerRevision: readOtaHeaderRevision(),
      pin: configuredHeaderIdentity,
      target: { kind: 'update', id: pendingId },
    };
  }
  const rollback = Updates.latestContext.rollback;
  if (
    !rollback ||
    !rollbackStamps.has(rollback.commitTime) ||
    rollbackStamps.get(rollback.commitTime) !== configuredHeaderIdentity
  )
    return null;
  return {
    headerRevision: readOtaHeaderRevision(),
    pin: configuredHeaderIdentity,
    target: { kind: 'rollback', commitTime: rollback.commitTime },
  };
}

/** Native fetch can finish before its pending-state event reaches JS. */
export async function waitForOtaReloadReceipt(
  lease: OtaOperationLease,
  fetched?: Updates.UpdateFetchResult,
): Promise<OtaReloadReceipt | null> {
  lease.assertActive();
  if (!fetched) return captureOtaReloadReceipt();
  if (!fetched.isNew && !fetched.isRollBackToEmbedded) return null;
  const matchingReceipt = () => {
    const receipt = captureOtaReloadReceipt();
    if (receipt === null) return null;
    if (fetched.isNew)
      return receipt.target.kind === 'update' && receipt.target.id === fetched.manifest.id ? receipt : null;
    return receipt.target.kind === 'rollback' ? receipt : null;
  };
  const ready = matchingReceipt();
  if (ready) return ready;
  let subscription: { remove: () => void } | undefined;
  const pending = new Promise<OtaReloadReceipt>((resolve) => {
    const check = () => {
      const receipt = matchingReceipt();
      if (receipt) resolve(receipt);
    };
    subscription = Updates.addUpdatesStateChangeListener(check);
    check();
  });
  try {
    return await lease.waitFor(pending);
  } finally {
    subscription?.remove();
  }
}

export function isOtaReloadReceiptCurrent(receipt: OtaReloadReceipt): boolean {
  const current = captureOtaReloadReceipt();
  if (current === null || current.headerRevision !== receipt.headerRevision || current.pin !== receipt.pin)
    return false;
  if (receipt.target.kind === 'rollback') {
    return current.target.kind === 'rollback' && current.target.commitTime === receipt.target.commitTime;
  }
  return current.target.kind === 'update' && current.target.id === receipt.target.id;
}

/**
 * Make the record match what the launch proved, once per launch and before
 * anything switches. Covers a phone pinned before the record existed and one
 * killed in the middle of a switch (the journal says which pin was written).
 * After an emergency launch there is nothing to adopt: `dropPinAfterEmergencyLaunch`.
 */
export function adoptRunningOtaPin(): void {
  if (launchPin === undefined) return;
  if (getSetting('otaPinSwitchInFlight') !== null) setSetting('otaPinSwitchInFlight', null);
  if (readOtaPinnedBranch() !== launchPin) setSetting('otaPinnedBranch', launchPin);
}

/** A submission deadline includes waiting for earlier OTA work and startup. */
export const PIN_CHANGE_TIMEOUT_MS = 180_000;
export const UPDATES_IDLE_TIMEOUT_MS = 120_000;

export function runPinChangeExclusively<Result>(task: (lease: OtaOperationLease) => Promise<Result>): Promise<Result> {
  return runOtaOperation(task, { timeoutMs: PIN_CHANGE_TIMEOUT_MS });
}

function updatesBusy(): boolean {
  const { isStartupProcedureRunning, isChecking, isDownloading } = Updates.latestContext;
  return isStartupProcedureRunning || isChecking || isDownloading;
}

export async function waitForOtaUpdatesIdle(lease: OtaOperationLease): Promise<void> {
  lease.assertActive();
  if (!updatesBusy()) {
    rememberPendingUpdate();
    return;
  }
  let subscription: { remove: () => void } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const idle = new Promise<void>((resolve, reject) => {
    const finish = () => {
      if (!updatesBusy()) resolve();
    };
    subscription = Updates.addUpdatesStateChangeListener(finish);
    timer = setTimeout(() => reject(new Error('expo-updates stayed busy')), UPDATES_IDLE_TIMEOUT_MS);
    finish();
  });
  try {
    await lease.waitFor(idle);
    lease.assertActive();
    rememberPendingUpdate();
  } finally {
    subscription?.remove();
    clearTimeout(timer);
  }
}

function restorePin(config: SurfConfig, pin: Pin, lease: OtaOperationLease): void {
  try {
    writePin(config, pin);
    setSetting('otaPinnedBranch', pin);
    setSetting('otaPinSwitchInFlight', null);
  } catch (cause) {
    lease.quarantine(cause);
    throw cause;
  }
}

/** App-owned phases prevent an opaque SDK surf from reloading after cancellation. */
async function surfOwningPin(branch: Pin, lease: OtaOperationLease): Promise<SurfOutcome> {
  const pinnedBefore = readOtaPinnedBranch();
  let fetched: Updates.UpdateFetchResult | undefined;
  const outcome = await switchTrackWithoutReload(branch, lease, (result) => {
    fetched = result;
  });
  lease.assertActive();
  if (outcome !== 'switched') return 'nothing-to-load';
  const receipt = await waitForOtaReloadReceipt(lease, fetched);
  if (receipt === null || !isOtaReloadReceiptCurrent(receipt)) return 'nothing-to-load';
  try {
    await lease.reload(() => Updates.reloadAsync());
  } catch (cause) {
    restorePin(requireSurfConfig(), pinnedBefore, lease);
    throw cause;
  }
  settleOwedLeave();
  return 'reloading';
}

function settleOwedLeave(): void {
  if (getSetting('otaLeaveOwed')) setSetting('otaLeaveOwed', false);
  if (getSetting('otaLeaveBlockedUpdateId') !== null) setSetting('otaLeaveBlockedUpdateId', null);
}

/**
 * Point this device at a PR's preview and reload onto it. `'reloading'` means
 * the app is restarting and nothing after the call will run; `'nothing-to-load'`
 * means no safe pending target was available. A target pin is retained only
 * when its data is known to be launchable.
 */
// async, not a plain `return surfTo(...)`: requireSurfConfig throws, and a
// synchronous throw out of a Promise-returning function is a trap for every
// caller that only wrote a .catch().
export async function surfToPr(prNumber: number): Promise<SurfOutcome> {
  return runPinChangeExclusively((lease) => surfOwningPin(prBranchName(prNumber), lease));
}

/** Clear the branch pin, go back to the build's own channel and reload onto it. */
export async function surfToProduction(): Promise<SurfOutcome> {
  return runPinChangeExclusively((lease) => surfOwningPin(null, lease));
}

/** Pin the tester-only staged main bundle; production is never remapped. */
export async function surfToStaging(): Promise<SurfOutcome> {
  return runPinChangeExclusively((lease) => surfOwningPin(STAGING_OTA_BRANCH, lease));
}

type LaunchableVerdict = { launchable: true } | { launchable: false; blockedOnUpdateId?: string };

/** Whether, with `target` just written as the override, the next cold start has an update stamped for it. */
async function findUpdateLaunchableUnder(
  target: Pin,
  lease: OtaOperationLease,
  onFetched?: (result: Updates.UpdateFetchResult) => void,
): Promise<LaunchableVerdict> {
  const check = await lease.native(() => Updates.checkForUpdateAsync());
  if (check.isAvailable) {
    const served = knownOnDisk(check.manifest.id, readPendingUpdateId());
    if (served.onDisk) {
      // The one answer that looks like success and is not. expo-updates would
      // report this id "downloaded" and leave its old stamp on it.
      if (served.stamp !== target) return { launchable: false, blockedOnUpdateId: check.manifest.id };
      // A preview reload needs native's pending target updated even when the
      // served UUID is already safely stamped on disk.
      if (!onFetched) return { launchable: true };
    }
    const pendingBefore = readPendingUpdateId();
    const fetched = await lease.native(() => fetchOwnedOtaUpdate());
    onFetched?.(fetched);
    if (!fetched.isNew) return { launchable: false };
    // A newer publish can land between the check and the download.
    const downloaded = knownOnDisk(fetched.manifest.id, pendingBefore);
    if (downloaded.onDisk && downloaded.stamp !== target) {
      return { launchable: false, blockedOnUpdateId: fetched.manifest.id };
    }
    if (stampedThisSession.get(fetched.manifest.id) !== target) {
      return { launchable: false, blockedOnUpdateId: fetched.manifest.id };
    }
    return { launchable: true };
  }

  const { UPDATE_REJECTED_BY_SELECTION_POLICY } = Updates.UpdateCheckResultNotAvailableReason;
  if (target === null && check.reason === UPDATE_REJECTED_BY_SELECTION_POLICY) {
    // The loader policy only gets as far as comparing commit times when the
    // LAUNCHED update's stamp already equals the configured headers. So this
    // answer, under no override, proves the running bundle launches with no
    // pin, whatever the record says (it is stale after a kill mid-leave).
    return { launchable: true };
  }
  // Nothing to download: no update on the server, one that failed before, a
  // rollback. Fine only when the bundle already running was launched under this
  // very pin. Not otherwise, and that includes "the channel has published
  // nothing": on iOS the embedded row may be stamped for the pin being left, so
  // dropping the pin would leave nothing launchable for good.
  return { launchable: launchPin !== undefined && launchPin === target };
}

/**
 * - `switched`: the pin is written and an update stamped for it is on disk, so
 *   the next cold start launches that update.
 * - `nothing-to-launch`: the server had nothing that would be launchable under
 *   the new pin, so the previous pin was put back and nothing changed.
 * - `blocked`: the same, for a named reason: the update the server serves is
 *   already on disk under ANOTHER stamp and cannot be restamped. Nothing changes
 *   until the server serves a different update id.
 */
export type TrackSwitchOutcome = 'switched' | 'nothing-to-launch' | 'blocked';

/**
 * Move this device to another branch for the NEXT launch, with no reload: wait
 * for expo-updates to be idle, write the pin, check, download, and keep the pin
 * only when that left an update stamped for it on disk. The running session is
 * never restarted, so this is safe with a queue running and a board connected.
 *
 * A failed or cancelled switch restores the previous pin after its active
 * native work settles. A hung native promise keeps ownership and its headers;
 * queued callers still reach their deadlines without running. No-data and
 * differently stamped cached updates also restore the previous pin.
 *
 * The app can still be killed between the header write and the restore. The
 * journal written around the switch lets the next launch tell what happened
 * (`readLaunchPin`, `adoptRunningOtaPin`), but that launch itself starts from
 * whatever is stamped for the written pin, which may be nothing.
 */
async function switchTrackWithoutReload(
  target: Pin,
  lease: OtaOperationLease,
  onFetched?: (result: Updates.UpdateFetchResult) => void,
): Promise<TrackSwitchOutcome> {
  const config = requireSurfConfig();
  await waitForOtaUpdatesIdle(lease);
  lease.assertActive();
  const pinnedBefore = readOtaPinnedBranch();
  setSetting('otaPinSwitchInFlight', { to: target });
  let committed = false;
  try {
    writePin(config, target);
    const verdict = await findUpdateLaunchableUnder(target, lease, onFetched);
    lease.assertActive();
    if (!verdict.launchable) {
      if (target !== null || verdict.blockedOnUpdateId === undefined) return 'nothing-to-launch';
      setSetting('otaLeaveBlockedUpdateId', verdict.blockedOnUpdateId);
      return 'blocked';
    }
    setSetting('otaPinnedBranch', target);
    setSetting('otaPinSwitchInFlight', null);
    if (getSetting('otaLeaveBlockedUpdateId') !== null) setSetting('otaLeaveBlockedUpdateId', null);
    if (target === null && getSetting('otaLeaveOwed')) setSetting('otaLeaveOwed', false);
    committed = true;
    return 'switched';
  } finally {
    // A timed-out native phase is still awaited by lease.native, so restoration
    // cannot change the headers used by its unfinished download.
    if (!committed) restorePin(config, pinnedBefore, lease);
  }
}

/**
 * Follow the early-updates branch from the next launch. See
 * `switchTrackWithoutReload`. Call inside `runPinChangeExclusively`.
 */
export async function joinEarlyUpdatesTrack(lease?: OtaOperationLease): Promise<TrackSwitchOutcome> {
  if (!lease) return runPinChangeExclusively((owned) => joinEarlyUpdatesTrack(owned));
  return switchTrackWithoutReload(EARLY_UPDATES_OTA_BRANCH, lease);
}

/**
 * Follow the build's own channel from the next launch. See
 * `switchTrackWithoutReload`. Call inside `runPinChangeExclusively`.
 */
export async function leaveForProductionTrack(lease?: OtaOperationLease): Promise<TrackSwitchOutcome> {
  if (!lease) return runPinChangeExclusively((owned) => leaveForProductionTrack(owned));
  return switchTrackWithoutReload(null, lease);
}

/**
 * This launch was an emergency launch: nothing on disk matched the configured
 * headers. Whatever pin may have caused that is dropped at once, with no
 * download and no waiting, because the alternative is the same emergency launch
 * at every open for as long as the phone is offline. With no pin, Android
 * always has its embedded row and iOS has whatever was stamped before the pin.
 *
 * Call inside an owned turn after waitForOtaUpdatesIdle. Synchronous, and safe
 * for a phone that never had a pin: an emergency launch
 * happens to any climber for reasons that have nothing to do with branches (a
 * crashing update), and for them this writes "no override" over no override.
 *
 * Returns whether there was any sign of a pin: a record, an interrupted switch,
 * or the early-updates choice. Only then is `fetchRegularUpdateAfterEmergencyLaunch`
 * worth its network and its turn in the queue.
 */
export function dropPinAfterEmergencyLaunch(): boolean {
  const config = requireSurfConfig();
  emergencyPinEvidence ||=
    readOtaPinnedBranch() !== null || getSetting('otaPinSwitchInFlight') !== null || getSetting('earlyUpdates');
  writePin(config, null);
  if (readOtaPinnedBranch() !== null) setSetting('otaPinnedBranch', null);
  if (getSetting('otaPinSwitchInFlight') !== null) setSetting('otaPinSwitchInFlight', null);
  settleOwedLeave();
  return emergencyPinEvidence;
}

/**
 * After `dropPinAfterEmergencyLaunch` found a pin: fetch a regular update so
 * the next cold start has current JS, not just the embedded bundle. Best
 * effort; it throws offline. Call inside `runPinChangeExclusively`.
 */
export async function fetchRegularUpdateAfterEmergencyLaunch(lease?: OtaOperationLease): Promise<void> {
  if (!lease) return runPinChangeExclusively((owned) => fetchRegularUpdateAfterEmergencyLaunch(owned));
  await waitForOtaUpdatesIdle(lease);
  const check = await lease.native(() => Updates.checkForUpdateAsync());
  if (!check.isAvailable || knownOnDisk(check.manifest.id, readPendingUpdateId()).onDisk) return;
  await lease.native(() => fetchOwnedOtaUpdate());
}
