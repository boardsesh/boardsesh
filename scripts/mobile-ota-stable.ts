/// <reference types="node" />

/** Trusted main-only controller. Planning is the default; writes require --apply. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { desiredOtaState, otaReleasePolicy, STABLE_BRANCH, STABLE_CANDIDATE_BRANCH } from '../infra/ota/config.ts';
import {
  captureProductionBaseline,
  parseStageReceipt,
  promoteArchivedOta,
  validateExport,
  verifyUnchangedPlatforms,
  readRolloutReceipt,
} from './mobile-ota-promote.ts';
import type { StageReceipt } from './mobile-ota-promote.ts';
import { listActiveRollouts, readUpdateHealth, revertRollout, setRolloutPercentage } from './lib/ota-rollout.ts';
import type { ActiveRollout, RolloutHealth } from './lib/ota-rollout.ts';
import { adminClientFromEnvironment, sameId } from './lib/xprem-admin.mts';
import type { XpremAdminClient } from './lib/xprem-admin.mts';
import {
  decideStable,
  initialStableState,
  parseCandidate,
  parseStableState,
  PLATFORMS,
  qualifyCandidate,
  releaseCycleDate,
  refreshAfterOwnFinish,
} from './lib/ota-stable.ts';
import type { StableCandidate, StableOperation, StableRelease, StableState } from './lib/ota-stable.ts';

export function readState(path: string): StableState {
  return existsSync(path) ? parseStableState(JSON.parse(readFileSync(path, 'utf8')) as unknown) : initialStableState();
}
export function saveState(path: string, state: StableState, runId: string): void {
  state.checkpointRunId = runId;
  // Reparse before writing so a corrupt or incomplete checkpoint never replaces a good one.
  const checked = parseStableState(state);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(checked, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}

interface ControllerOptions {
  client: XpremAdminClient;
  state: StableState;
  stagePath: string;
  manifestUrl: string;
  token: string;
  apply: boolean;
  now: Date;
  clock?: () => Date;
  save: () => void;
  log: (message: string) => void;
  operation?: StableOperation;
  expectedSha?: string;
}
const runtimes = (receipt: StageReceipt) => ({
  ios: receipt.platforms.ios.runtimeVersion,
  android: receipt.platforms.android.runtimeVersion,
});
const baseline = (options: ControllerOptions, receipt: StageReceipt, branch = STABLE_BRANCH) =>
  captureProductionBaseline({
    manifestUrl: options.manifestUrl,
    appId: desiredOtaState.appId,
    runtimeVersions: runtimes(receipt),
    branch,
    ...(branch === STABLE_BRANCH ? {} : { emptyBranchReader: options.client }),
  });
function validateArchive(stagePath: string, receipt: StageReceipt): void {
  for (const platform of PLATFORMS) {
    validateExport(join(stagePath, platform), platform, receipt.platforms[platform].bundleSha256);
  }
}
function validateFrozenCandidate(options: ControllerOptions, candidate: StableCandidate): void {
  const archived = parseCandidate(
    JSON.parse(readFileSync(join(options.stagePath, 'candidate.json'), 'utf8')) as unknown,
  );
  // Production baselines may differ only after this controller's own recorded finish.
  if (
    archived.sourceRunId !== candidate.sourceRunId ||
    archived.preparationRunId !== candidate.preparationRunId ||
    archived.receipt.commitHash !== candidate.receipt.commitHash ||
    JSON.stringify(archived.receipt.platforms) !== JSON.stringify(candidate.receipt.platforms)
  )
    throw new Error('Frozen artifact differs from checkpoint.');
  validateArchive(options.stagePath, candidate.receipt);
}
const verifyUnchanged = (options: ControllerOptions, active: StableRelease) =>
  verifyUnchangedPlatforms({
    receipt: active.candidate.receipt,
    iosExport: join(options.stagePath, 'ios'),
    androidExport: join(options.stagePath, 'android'),
    manifestUrl: options.manifestUrl,
    unchangedPlatforms: active.unchangedPlatforms,
  });
async function promote(
  options: ControllerOptions,
  candidate: StableCandidate,
  branch: string,
  receiptPath: string,
  rolloutReceiptPath?: string,
): Promise<void> {
  validateArchive(options.stagePath, candidate.receipt);
  writeFileSync(receiptPath, JSON.stringify(candidate.receipt));
  await promoteArchivedOta({
    receiptPath,
    iosExport: join(options.stagePath, 'ios'),
    androidExport: join(options.stagePath, 'android'),
    manifestUrl: options.manifestUrl,
    token: options.token,
    branch,
    ...(branch === STABLE_BRANCH ? {} : { emptyBranchReader: options.client }),
    ...(rolloutReceiptPath
      ? {
          rollout: {
            percentage: otaReleasePolicy.canarySteps[0],
            receiptPath: rolloutReceiptPath,
            connect: async () => options.client,
            onRecord: (record) => {
              const active = options.state.active;
              if (!active || active.candidate.receipt.commitHash !== candidate.receipt.commitHash)
                throw new Error('Promotion record does not belong to the active candidate.');
              const updateIds = { ...record.updateIds };
              const unchangedPlatforms = { ...record.unchangedPlatforms };
              parseStableState({ ...options.state, active: { ...active, updateIds, unchangedPlatforms } });
              active.updateIds = updateIds;
              active.unchangedPlatforms = unchangedPlatforms;
              options.save();
            },
          },
        }
      : {}),
  });
}
export async function prepareStable(
  options: ControllerOptions,
  sourceRunId: string,
  sourceSha: string,
  preparationRunId: string,
): Promise<StableCandidate> {
  const receipt = parseStageReceipt(
    JSON.parse(readFileSync(join(options.stagePath, 'receipt.json'), 'utf8')) as unknown,
  );
  if (receipt.commitHash !== sourceSha) throw new Error('Source artifact SHA differs from its trusted deployment run.');
  validateArchive(options.stagePath, receipt);
  if (options.state.rejectedCommit === sourceSha || options.state.lastCompletedCommit === sourceSha)
    throw new Error('No new unrejected candidate to prepare.');
  // Capture NOW: the source stage may predate a previous controller finish.
  const candidate = parseCandidate({
    receipt: { ...receipt, baselineProductionUpdateIds: await baseline(options, receipt) },
    sourceRunId,
    preparationRunId,
    preparedAt: options.now.toISOString(),
    qaPassed: false,
  });
  if (!options.apply) {
    options.log(`Plan: freeze ${sourceSha} from deploy ${sourceRunId}; no bytes published.`);
    return candidate;
  }
  // This copy uses the candidate branch's own baseline; the production guard is kept immutable for start.
  const frozenCopy = {
    ...candidate,
    receipt: {
      ...candidate.receipt,
      baselineProductionUpdateIds: await baseline(options, receipt, STABLE_CANDIDATE_BRANCH),
    },
  };
  await promote(options, frozenCopy, STABLE_CANDIDATE_BRANCH, join(options.stagePath, 'candidate-upload-receipt.json'));
  options.state.candidate = candidate;
  options.save();
  writeFileSync(join(options.stagePath, 'candidate.json'), JSON.stringify(candidate, null, 2));
  // QA reads this explicit production-baseline receipt, while exports remain unchanged.
  writeFileSync(join(options.stagePath, 'receipt.json'), JSON.stringify(candidate.receipt, null, 2));
  return candidate;
}

async function ownedHealth(
  options: ControllerOptions,
  active: StableRelease,
  live: ActiveRollout[],
  includeHealth = true,
): Promise<RolloutHealth[]> {
  const health: RolloutHealth[] = [];
  for (const platform of PLATFORMS) {
    const id = active.updateIds[platform];
    if (!id) continue;
    const runtimeVersion = active.candidate.receipt.platforms[platform].runtimeVersion;
    const details = await options.client.getUpdateDetails(STABLE_BRANCH, runtimeVersion, id);
    if (
      details.commitHash !== active.candidate.receipt.commitHash ||
      details.platform !== platform ||
      !details.updateUUID
    ) {
      throw new Error(`${platform} leased update does not match the recorded candidate.`);
    }
    const rollout = live.find(
      (entry) => entry.platform === platform && entry.runtimeVersion === runtimeVersion && sameId(entry.updateId, id),
    );
    if (rollout) {
      if (rollout.controlUpdateId === null) throw new Error(`${platform} has no production control.`);
      const control = await options.client.getUpdateDetails(STABLE_BRANCH, runtimeVersion, rollout.controlUpdateId);
      if (control.updateUUID !== active.candidate.receipt.baselineProductionUpdateIds[platform])
        throw new Error(`${platform} control differs from the recorded baseline.`);
      if (rollout.percentage !== active.percentage && rollout.percentage !== active.pendingPercentage) {
        throw new Error(`${platform} rollout percentage changed outside this controller.`);
      }
    } else {
      const current = (await baseline(options, active.candidate.receipt))[platform];
      if (
        active.phase !== 'finishing' ||
        current !== details.updateUUID ||
        (active.completedPlatforms[platform] && active.completedPlatforms[platform] !== current)
      ) {
        throw new Error(
          `${platform} owned rollout disappeared; restore the checkpoint or reconcile the external release before retrying.`,
        );
      }
    }
    if (!includeHealth) continue;
    const reported = await readUpdateHealth(
      options.client,
      details.updateUUID,
      active.candidate.receipt.baselineProductionUpdateIds[platform],
      otaReleasePolicy.health,
    );
    health.push({
      ...reported,
      rollout: rollout ?? {
        branch: STABLE_BRANCH,
        runtimeVersion,
        platform,
        updateId: id,
        controlUpdateId: null,
        percentage: 100,
        createdAt: active.startedAt,
      },
    });
  }
  return health;
}
function assertOwnedOnly(active: StableRelease | null, live: ActiveRollout[]): void {
  for (const rollout of live) {
    const platform = rollout.platform;
    if (
      (platform !== 'ios' && platform !== 'android') ||
      !active ||
      rollout.runtimeVersion !== active.candidate.receipt.platforms[platform].runtimeVersion ||
      !sameId(rollout.updateId, active.updateIds[platform] ?? '')
    ) {
      throw new Error(
        `Unowned rollout ${rollout.updateId} on ${rollout.runtimeVersion}; refusing all production writes. Use the trusted unlock/recovery runbook.`,
      );
    }
  }
}
/** The workflow restores this receipt from the same trusted producer artifact as state.json. */
function recoverStartingRecord(options: ControllerOptions): void {
  const active = options.state.active;
  const path = join(options.stagePath, 'rollout-receipt.json');
  if (!active || active.phase !== 'starting' || !existsSync(path)) return;
  const recovered = readRolloutReceipt(path, STABLE_BRANCH, active.candidate.receipt);
  const updateIds = { ...active.updateIds };
  const unchangedPlatforms = { ...active.unchangedPlatforms };
  for (const platform of PLATFORMS) {
    const recoveredId = recovered.updateIds[platform];
    const recoveredUUID = recovered.unchangedPlatforms[platform];
    if (recoveredId && ((updateIds[platform] && updateIds[platform] !== recoveredId) || unchangedPlatforms[platform]))
      throw new Error('Recovered lease conflicts with checkpoint.');
    if (
      recoveredUUID &&
      ((unchangedPlatforms[platform] && unchangedPlatforms[platform] !== recoveredUUID) || updateIds[platform])
    )
      throw new Error('Recovered unchanged attestation conflicts with checkpoint.');
    if (recoveredId) {
      if (recovered.baselineUpdateIds[platform] !== active.candidate.receipt.baselineProductionUpdateIds[platform])
        throw new Error('Recovered lease baseline differs from candidate.');
      updateIds[platform] = recoveredId;
    }
    if (recoveredUUID) unchangedPlatforms[platform] = recoveredUUID;
  }
  const restored = { ...active, updateIds, unchangedPlatforms };
  parseStableState({ ...options.state, active: restored });
  options.state.active = restored;
  if (options.apply) options.save();
}
/** Abort preserves external publications, reverting only the still-live owned rows. */
export async function abortStable(options: ControllerOptions): Promise<void> {
  recoverStartingRecord(options);
  const active = options.state.active;
  const live = await listActiveRollouts(options.client, STABLE_BRANCH);
  assertOwnedOnly(active, live);
  if (!options.apply) {
    options.log('Plan: abort owned canaries, invalidate candidate, preserve external heads.');
    return;
  }
  if (!active) {
    if (options.state.candidate) options.state.rejectedCommit = options.state.candidate.receipt.commitHash;
    options.state.candidate = null;
    options.save();
    return;
  }
  const current = await baseline(options, active.candidate.receipt);
  for (const platform of PLATFORMS) {
    if (active.unchangedPlatforms[platform]) continue;
    const id = active.updateIds[platform];
    const stillLive = live.some(
      (entry) =>
        entry.platform === platform &&
        entry.runtimeVersion === active.candidate.receipt.platforms[platform].runtimeVersion &&
        sameId(entry.updateId, id ?? ''),
    );
    if (stillLive) continue;
    if (!current[platform]) throw new Error(`${platform} has no approved stable head; restore it before aborting.`);
    if (active.phase === 'finishing' && id) {
      const owned = await options.client.getUpdateDetails(
        STABLE_BRANCH,
        active.candidate.receipt.platforms[platform].runtimeVersion,
        id,
      );
      if (owned.updateUUID === current[platform])
        throw new Error(
          `Restore the completed ${platform} platform to approved stable bytes before aborting a partial finish.`,
        );
    }
    active.completedPlatforms[platform] = current[platform];
  }
  active.phase = 'reverting';
  active.pendingPercentage = null;
  options.state.candidate = null;
  options.save();
  options.log('Abort: preserving observed external heads and reverting remaining owned canaries.');
  // Recovery must finish as a tick, even when a manual start detected the
  // external replacement. A start cannot operate on the reverting checkpoint.
  await tickStable({ ...options, operation: 'tick' });
}
export async function tickStable(options: ControllerOptions): Promise<void> {
  const { state, now } = options;
  const operation = options.operation ?? 'tick';
  const selected = state.active?.candidate ?? state.candidate;
  if (operation === 'force-release' && !options.expectedSha)
    throw new Error('force-release requires --expected-sha naming the full qualified candidate commit.');
  if (
    options.expectedSha &&
    (!/^[a-f0-9]{40}$/.test(options.expectedSha) || selected?.receipt.commitHash !== options.expectedSha)
  )
    throw new Error('Expected SHA does not match the selected active or waiting candidate.');
  if (operation === 'start' && state.active && state.active.phase !== 'starting')
    throw new Error('A release is already active; use tick, force-release or abort.');
  if (operation === 'force-release' && state.active?.phase === 'reverting')
    throw new Error('A reverting release must finish recovery before forcing another release.');
  const forced = operation === 'force-release' || state.active?.forceRelease === true;
  if (forced && state.active?.phase !== 'reverting') {
    if (!selected?.qaPassed) throw new Error('Force release requires successful frozen candidate QA.');
    if (selected.receipt.commitHash === state.rejectedCommit)
      throw new Error('The selected candidate was rejected; prepare a new candidate.');
    const age = now.getTime() - Date.parse(selected.preparedAt);
    if (age < 0 || age > 30 * 24 * 3600_000) throw new Error('Candidate receipt is expired or from the future.');
    validateFrozenCandidate(options, selected);
  }
  // Reconcile durable leases before classifying live rows as owned or foreign.
  recoverStartingRecord(options);
  const live = await listActiveRollouts(options.client, STABLE_BRANCH);
  assertOwnedOnly(state.active, live);
  if (state.active && state.active.phase !== 'reverting' && Object.keys(state.active.unchangedPlatforms).length > 0) {
    const current = await baseline(options, state.active.candidate.receipt);
    if (
      PLATFORMS.some(
        (platform) =>
          state.active!.unchangedPlatforms[platform] &&
          current[platform] !== state.active!.unchangedPlatforms[platform],
      )
    ) {
      if (operation === 'force-release')
        throw new Error('An unchanged production head changed; reconcile it before forcing release.');
      // Preserve an external replacement and revert only our changed sibling.
      await abortStable(options);
      return;
    }
    await verifyUnchanged(options, state.active);
  }
  if (state.active && state.active.phase !== 'reverting') {
    const active = state.active;
    const missing = PLATFORMS.filter(
      (platform) =>
        !active.unchangedPlatforms[platform] &&
        !live.some(
          (entry) =>
            entry.platform === platform &&
            entry.runtimeVersion === active.candidate.receipt.platforms[platform].runtimeVersion &&
            sameId(entry.updateId, active.updateIds[platform] ?? ''),
        ),
    );
    let interrupted = active.phase === 'ramping' && missing.length > 0;
    if (missing.length > 0 && active.phase !== 'ramping') {
      const current = await baseline(options, active.candidate.receipt);
      let externalFinishes = 0;
      for (const platform of missing) {
        if (active.phase === 'starting') {
          // An absent lease with the original head is still a resumable partial start.
          interrupted ||= current[platform] !== active.candidate.receipt.baselineProductionUpdateIds[platform];
        } else {
          const id = active.updateIds[platform];
          if (!id) throw new Error(`${platform} has no owned update ID.`);
          const owned = await options.client.getUpdateDetails(
            STABLE_BRANCH,
            active.candidate.receipt.platforms[platform].runtimeVersion,
            id,
          );
          // A completed owned UUID is normal partial-finish recovery. A different
          // stable head belongs to an external publication, including a critical release.
          if (current[platform] !== owned.updateUUID) externalFinishes += 1;
        }
      }
      if (active.phase === 'finishing')
        interrupted =
          missing.length === PLATFORMS.filter((platform) => !active.unchangedPlatforms[platform]).length &&
          externalFinishes === missing.length;
    }
    if (interrupted) {
      if (operation === 'force-release')
        throw new Error('An owned rollout disappeared; reconcile production before forcing release.');
      await abortStable(options);
      return;
    }
  }
  const health =
    state.active && state.active.phase !== 'starting' && state.active.phase !== 'reverting'
      ? await ownedHealth(options, state.active, live, !forced)
      : [];
  const decision = decideStable(state, now, health, operation);
  options.log(`${options.apply ? 'Apply' : 'Plan'}: ${decision.action}. ${decision.reason}`);
  if (options.apply && decision.action === 'hold' && decision.reason.includes('manual recovery'))
    throw new Error(decision.reason);
  if (options.apply && operation !== 'tick' && decision.action === 'hold') throw new Error(decision.reason);
  if (!options.apply || decision.action === 'hold') return;
  if (decision.action === 'start' || decision.action === 'resume') {
    const candidate = state.active?.candidate ?? state.candidate;
    if (!candidate) throw new Error('No recorded candidate.');
    validateFrozenCandidate(options, candidate);
    if (PLATFORMS.some((platform) => candidate.receipt.baselineProductionUpdateIds[platform] === null)) {
      throw new Error('A native runtime has no stable baseline. Wait for its post-build publication.');
    }
    if (!state.active) {
      const current = await baseline(options, candidate.receipt);
      if (PLATFORMS.some((platform) => current[platform] !== candidate.receipt.baselineProductionUpdateIds[platform])) {
        state.rejectedCommit = candidate.receipt.commitHash;
        state.candidate = null;
        options.save();
        options.log('Candidate invalidated: production changed after preparation. No leases or bytes created.');
        if (operation !== 'tick') throw new Error('Production changed after candidate preparation; prepare again.');
        return;
      }
      state.active = {
        candidate,
        phase: 'starting',
        updateIds: {},
        unchangedPlatforms: {},
        completedPlatforms: {},
        startedAt: now.toISOString(),
        stepSince: now.toISOString(),
        percentage: otaReleasePolicy.canarySteps[0],
        pendingPercentage: null,
        ...(forced ? { forceRelease: true } : {}),
      };
      state.candidate = null;
      state.lastStartedDate = releaseCycleDate(now);
      options.save();
    }
    if (forced) {
      state.active!.forceRelease = true;
      options.save();
    }
    recoverStartingRecord(options);
    const active = state.active!;
    const rolloutReceiptPath = join(options.stagePath, 'rollout-receipt.json');
    writeFileSync(
      rolloutReceiptPath,
      JSON.stringify({
        branch: STABLE_BRANCH,
        commitHash: candidate.receipt.commitHash,
        updateIds: active.updateIds,
        unchangedPlatforms: active.unchangedPlatforms,
        baselineUpdateIds: candidate.receipt.baselineProductionUpdateIds,
      }),
    );
    try {
      await promote(
        options,
        candidate,
        STABLE_BRANCH,
        join(options.stagePath, 'production-receipt.json'),
        rolloutReceiptPath,
      );
    } finally {
      const recorded = readRolloutReceipt(rolloutReceiptPath, STABLE_BRANCH, candidate.receipt);
      const updateIds = { ...active.updateIds, ...recorded.updateIds };
      const unchangedPlatforms = { ...active.unchangedPlatforms, ...recorded.unchangedPlatforms };
      parseStableState({ ...state, active: { ...active, updateIds, unchangedPlatforms } });
      active.updateIds = updateIds;
      active.unchangedPlatforms = unchangedPlatforms;
      options.save();
    }
    await verifyUnchanged(options, active);
    if (PLATFORMS.every((platform) => active.unchangedPlatforms[platform])) {
      state.lastCompletedCommit = active.candidate.receipt.commitHash;
      state.active = null;
      options.save();
      options.log('Both platforms already serve the frozen bytes; candidate handled without rollout writes.');
      return;
    }
    active.phase = 'ramping';
    // Start clocks after every changed canary and unchanged attestation is confirmed.
    const completedAt = new Date(Math.max(now.getTime(), (options.clock?.() ?? new Date()).getTime())).toISOString();
    active.startedAt = completedAt;
    active.stepSince = completedAt;
    options.save();
    if (active.forceRelease) await tickStable({ ...options, operation: 'tick' });
    return;
  }
  const active = state.active;
  if (!active) throw new Error('No active release.');
  const recoveryRevert = active.phase === 'reverting';
  if (decision.action === 'raise') active.pendingPercentage = decision.percentage;
  if (decision.action === 'finish') {
    if (forced) active.forceRelease = true;
    active.phase = 'finishing';
    // A forced finish retains a partial ramp's exact admitted percentages for recovery.
    if (!active.forceRelease) active.pendingPercentage = null;
  }
  if (decision.action === 'revert') {
    active.phase = 'reverting';
    active.pendingPercentage = null;
  }
  options.save(); // Persist intent BEFORE the first platform write.
  const completedBaseline = await baseline(options, active.candidate.receipt);
  for (const platform of PLATFORMS) {
    if (active.completedPlatforms[platform] && active.completedPlatforms[platform] !== completedBaseline[platform]) {
      throw new Error(`${platform} completed head changed outside this controller; refusing the remaining write.`);
    }
  }
  for (const platform of PLATFORMS) {
    if (active.unchangedPlatforms[platform]) continue;
    if (active.completedPlatforms[platform]) continue;
    if (!recoveryRevert) await verifyUnchanged(options, active);
    const id = active.updateIds[platform];
    if (!id) throw new Error(`${platform} has no owned update ID.`);
    const runtimeVersion = active.candidate.receipt.platforms[platform].runtimeVersion;
    const target = { branch: STABLE_BRANCH, runtimeVersion, platform, expectedUpdateId: id };
    if (decision.action === 'revert') {
      await revertRollout(options.client, target);
      const restored = (await baseline(options, active.candidate.receipt))[platform];
      if (!restored) throw new Error('Reverted update has no native UUID; reconcile manually.');
      active.completedPlatforms[platform] = restored;
    } else {
      const percentage = decision.action === 'raise' ? decision.percentage : 100;
      const fresh = await options.client.getUpdateRollout(STABLE_BRANCH, runtimeVersion);
      if (decision.action === 'finish' && !fresh.updates.some((entry) => sameId(entry.updateId, id))) {
        // Only the same native UUID served to everyone proves a retried finish completed.
        const details = await options.client.getUpdateDetails(STABLE_BRANCH, runtimeVersion, id);
        if (details.updateUUID !== (await baseline(options, active.candidate.receipt))[platform])
          throw new Error('Interrupted finish cannot be proven.');
      } else await setRolloutPercentage(options.client, target, percentage);
      if (decision.action === 'finish') {
        const uuid = (await options.client.getUpdateDetails(STABLE_BRANCH, runtimeVersion, id)).updateUUID;
        if (!uuid) throw new Error('Finished update has no native UUID.');
        active.completedPlatforms[platform] = uuid;
      }
    }
    options.save();
  }
  if (decision.action === 'raise') {
    active.percentage = decision.percentage;
    active.pendingPercentage = null;
    active.stepSince = new Date(Math.max(now.getTime(), (options.clock?.() ?? new Date()).getTime())).toISOString();
  } else {
    if (decision.action === 'finish') {
      state.lastCompletedCommit = active.candidate.receipt.commitHash;
      if (state.candidate) {
        try {
          state.candidate = refreshAfterOwnFinish(state.candidate, active, {
            ...active.unchangedPlatforms,
            ...active.completedPlatforms,
          } as Record<'ios' | 'android', string>);
        } catch (error) {
          options.log(`Candidate invalidated: ${error instanceof Error ? error.message : String(error)}`);
          state.candidate = null;
        }
      }
    } else {
      state.rejectedCommit = active.candidate.receipt.commitHash;
      state.candidate = null;
    }
    state.active = null;
  }
  options.save();
}

export function parseStableArgs(argv: string[]): { command: string; apply: boolean; flags: Record<string, string> } {
  const [command = 'tick', ...rest] = argv;
  if (!['prepare', 'qualify', 'tick', 'start', 'force-release', 'abort'].includes(command))
    throw new Error('Use prepare, qualify, tick, start, force-release or abort; writes require --apply.');
  let apply = false;
  const flags: Record<string, string> = {};
  const allowed = [
    '--state',
    '--stage',
    '--run-id',
    '--source-run-id',
    '--source-sha',
    '--loaded-state-run-id',
    '--sha',
    '--boot-sha',
    '--branch',
    '--smoke-result',
    '--boot-result',
    '--smoke-passed',
    '--boot-passed',
    '--expected-sha',
  ];
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    if (flag === '--apply') {
      apply = true;
      continue;
    }
    if (!allowed.includes(flag) || flags[flag] !== undefined) throw new Error(`Unknown or repeated argument: ${flag}`);
    const argument = rest[++index];
    if (!argument || argument.startsWith('--')) throw new Error(`${flag} needs a value.`);
    flags[flag] = argument;
  }
  if (!flags['--state'] || !flags['--stage']) throw new Error('Provide --state and --stage paths.');
  if (flags['--expected-sha'] && !/^[a-f0-9]{40}$/.test(flags['--expected-sha']))
    throw new Error('--expected-sha must be a full lowercase commit SHA.');
  if (command === 'force-release' && !flags['--expected-sha'])
    throw new Error('force-release requires --expected-sha.');
  if (flags['--expected-sha'] && command !== 'start' && command !== 'force-release')
    throw new Error('--expected-sha is only supported by start and force-release.');
  return { command, apply, flags };
}
async function main(): Promise<void> {
  const { command, apply, flags } = parseStableArgs(process.argv.slice(2));
  if (apply && process.env.GITHUB_ACTIONS === 'true' && Number(process.env.GITHUB_RUN_ATTEMPT ?? '1') !== 1) {
    throw new Error('Dispatch a new controller run to retry; same-run reruns cannot replace durable receipts.');
  }
  if (apply && process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_REF !== 'refs/heads/main')
    throw new Error('Only trusted main can apply stable release changes.');
  const state = readState(flags['--state']);
  const loaded = flags['--loaded-state-run-id'];
  if (loaded && state.checkpointRunId !== loaded)
    throw new Error('Checkpoint producer differs from its trusted artifact run.');
  const runId = flags['--run-id'] ?? process.env.GITHUB_RUN_ID ?? '0';
  const save = () => {
    if (apply) saveState(flags['--state'], state, runId);
  };
  if (command === 'qualify') {
    if (!state.candidate || state.candidate.preparationRunId !== runId)
      throw new Error('Only this preparation run can qualify its candidate.');
    const receipt = parseStageReceipt(
      JSON.parse(readFileSync(join(flags['--stage'], 'receipt.json'), 'utf8')) as unknown,
    );
    state.candidate = qualifyCandidate(state.candidate, {
      receipt,
      sha: flags['--sha'],
      bootSha: flags['--boot-sha'],
      branch: flags['--branch'],
      smokeResult: flags['--smoke-result'],
      bootResult: flags['--boot-result'],
      smokePassed: flags['--smoke-passed'],
      bootPassed: flags['--boot-passed'],
    });
    save();
    console.log(`Frozen candidate QA: ${state.candidate.qaPassed ? 'passed' : 'rejected'}`);
    console.log(`Candidate SHA: ${state.candidate.receipt.commitHash}`);
    if (process.env.GITHUB_STEP_SUMMARY)
      writeFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `Frozen candidate QA: ${state.candidate.qaPassed ? 'passed' : 'rejected'}\n\nCandidate SHA: \`${state.candidate.receipt.commitHash}\`\n`,
        { flag: 'a' },
      );
    if (!state.candidate.qaPassed) process.exitCode = 1;
    return;
  }
  try {
    // Login failure must still retain a checkpoint belonging to this run.
    // Otherwise its uploaded copy has the previous producer ID and blocks recovery.
    const client = await adminClientFromEnvironment({
      appId: desiredOtaState.appId,
      defaultBaseUrl: desiredOtaState.baseUrl,
      environment: process.env,
    });
    const options: ControllerOptions = {
      client,
      state,
      stagePath: flags['--stage'],
      manifestUrl: process.env.EXPO_UPDATES_URL || `${desiredOtaState.baseUrl}/manifest`,
      token: process.env.EOO_TOKEN ?? '',
      apply,
      now: new Date(),
      save,
      log: console.log,
      ...(command === 'start' || command === 'force-release' ? { operation: command } : {}),
      ...(flags['--expected-sha'] ? { expectedSha: flags['--expected-sha'] } : {}),
    };
    if (command === 'prepare') {
      const candidate = await prepareStable(options, flags['--source-run-id'], flags['--source-sha'], runId);
      if (process.env.GITHUB_OUTPUT)
        writeFileSync(
          process.env.GITHUB_OUTPUT,
          `sha=${candidate.receipt.commitHash}\nreceipt=${JSON.stringify(candidate.receipt)}\n`,
          { flag: 'a' },
        );
    } else if (command === 'abort') {
      await abortStable(options);
    } else {
      await tickStable(options);
    }
  } finally {
    save();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error: unknown) => {
    console.error(`[ota-stable] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
