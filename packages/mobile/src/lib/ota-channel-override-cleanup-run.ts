import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import {
  clearRetiredChannelOverride,
  isBranchSurfingBuild,
  readBakedChannelName,
  wasStaleOverrideActive,
} from './ota-channel-override-cleanup';
import { getPreference, removePreference, setPreference } from './preference-store';
import { runOtaOperation, type OtaOperationLease } from './ota-operation-owner';
import { clearOwnedOtaHeaders, dropPinAfterEmergencyLaunch, waitForOtaUpdatesIdle } from './qa/qa-surf';

export type ChannelOverrideCleanupRun = {
  /**
   * This launch's manifest request used a retired override, and
   * `Updates.channel` still names it until the next JS runtime.
   */
  staleOverrideActive: boolean;
};

let cleanupRun: Promise<ChannelOverrideCleanupRun> | null = null;

/** Fingerprint-bound, so it is the same answer for the whole launch. */
export function isSurfingBuildForThisLaunch(): boolean {
  return isBranchSurfingBuild({
    development: __DEV__,
    updatesEnabled: Updates.isEnabled,
    updatesConfig: Constants.expoConfig?.updates,
  });
}

async function runChannelOverrideCleanup(lease: OtaOperationLease): Promise<ChannelOverrideCleanupRun> {
  const branchSurfingBuild = isSurfingBuildForThisLaunch();
  if (branchSurfingBuild && Updates.isEmergencyLaunch) {
    await waitForOtaUpdatesIdle(lease);
    lease.assertActive();
    // Repair comes before schema recovery can check or fetch. Its no-network
    // clear survives an offline launch; later sync retains the evidence that
    // a regular download is worth attempting.
    try {
      dropPinAfterEmergencyLaunch();
    } catch (error) {
      lease.quarantine(error);
      throw error;
    }
  }
  const cleanup = await clearRetiredChannelOverride({
    branchSurfingBuild,
    readMigrationComplete: (key) => lease.waitFor(getPreference(key)),
    clearRequestHeadersOverride: async () => {
      await waitForOtaUpdatesIdle(lease);
      lease.assertActive();
      try {
        clearOwnedOtaHeaders();
      } catch (error) {
        lease.quarantine(error);
        throw error;
      }
    },
    removeLegacyMirror: (key) => lease.native(() => removePreference(key)),
    markMigrationComplete: (key, complete) => lease.native(() => setPreference(key, complete)),
  });
  return {
    staleOverrideActive: wasStaleOverrideActive({
      cleanup,
      launchChannel: Updates.channel,
      bakedChannel: readBakedChannelName(Constants.expoConfig?.updates),
    }),
  };
}

/**
 * The retired-override cleanup, run at most once per JS runtime. Two callers
 * wait on the same promise: `OtaBranchSurfingInitializer` publishes QA
 * readiness from it, and the launch update gate needs to know whether the
 * launch-time manifest request went out under a stale override. Sharing one
 * run is what makes that hand-off deterministic, whichever effect fires first.
 *
 * A rejection is kept, not retried: both callers see the same failure and the
 * cleanup gets its next chance on the next launch, as before.
 */
export function runChannelOverrideCleanupOnce(): Promise<ChannelOverrideCleanupRun> {
  cleanupRun ??= runOtaOperation(runChannelOverrideCleanup, { timeoutMs: 180_000 });
  return cleanupRun;
}

export function resetChannelOverrideCleanupRunForTests(): void {
  cleanupRun = null;
}
