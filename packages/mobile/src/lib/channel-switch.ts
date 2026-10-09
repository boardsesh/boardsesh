// Pure orchestration for the EAS preview-build branch switcher. All platform I/O
// (expo-updates, AsyncStorage mirror, telemetry) is injected so the commit/revert
// state machine owned by BranchSwitcherScreen.tsx can be unit-tested without a
// rendered component or native modules.
import { runOtaOperation, type OtaOperationLease, type OtaOperationOptions } from './ota-operation-owner';

const CHANNEL_SWITCH_TIMEOUT_MS = 180_000;

// The AsyncStorage key mirroring the active channel override for display. The real
// override is stored natively by expo-updates and survives cold starts; this mirror
// is best-effort (there is no native read-back API).
export const OTA_CHANNEL_OVERRIDE_KEY = 'dev_ota_channel_override';

// The channels our OTA server publishes to (see docs/mobile-ota-updates.md).
export const PRESET_CHANNELS = ['production', 'preview-1', 'preview-2', 'preview-3', 'preview-4'] as const;

// The channel rows to show: the presets, plus the active override if it isn't
// already a preset (de-duplicated).
export function buildChannelList(override: string | null): string[] {
  return Array.from(new Set<string>([...PRESET_CHANNELS, ...(override ? [override] : [])]));
}

export type ChannelSwitchDeps = {
  waitForIdle?: (lease: OtaOperationLease) => Promise<void>;
  // Override the build's `expo-channel-name` request header (null clears it).
  applyOverride: (channel: string | null) => void;
  checkForUpdate: () => Promise<{ isAvailable: boolean }>;
  fetchUpdate: () => Promise<unknown>;
  /** The fetch may return a cached UUID stamped for another channel. */
  canLaunchFetchedUpdate?: (lease: OtaOperationLease) => Promise<boolean>;
  /** Revalidate the saved launch receipt synchronously after mirror writes. */
  isFetchedUpdateCurrent?: () => boolean;
  reload: () => Promise<void>;
  writeMirror: (channel: string) => Promise<void>;
  clearMirror: () => Promise<void>;
  // Best-effort mirror writes report through this instead of throwing.
  onMirrorError: (error: unknown) => void;
};

export type ChannelSwitchResult =
  // Update fetched and reload initiated (in production the app restarts here).
  | { status: 'switched' }
  // Committed (update downloaded) but reload failed — applies on next restart.
  | { status: 'pending-restart' }
  // Pre-commit failure: native override + mirror restored to the previous channel.
  | { status: 'reverted'; error: unknown };

/**
 * Switch onto `channel`: override the header, pull a compatible update, then
 * reload. `previousOverride` is captured by the caller BEFORE any await so the
 * revert targets the channel that was live when the switch began (not a stale
 * render-closure value). Nothing is persisted until the update is downloaded, and
 * any pre-commit failure fully reverts.
 */
export async function performChannelSwitch(
  channel: string,
  previousOverride: string | null,
  runtimeVersion: string,
  deps: ChannelSwitchDeps,
  options?: OtaOperationOptions,
): Promise<ChannelSwitchResult> {
  return runOtaOperation((lease) => switchChannelOwned(channel, previousOverride, runtimeVersion, deps, lease), {
    timeoutMs: CHANNEL_SWITCH_TIMEOUT_MS,
    ...options,
  }).catch((error: unknown) => ({ status: 'reverted', error }));
}

async function switchChannelOwned(
  channel: string,
  previousOverride: string | null,
  runtimeVersion: string,
  deps: ChannelSwitchDeps,
  lease: OtaOperationLease,
): Promise<ChannelSwitchResult> {
  let committed = false;
  let headersApplied = false;
  try {
    await deps.waitForIdle?.(lease);
    lease.assertActive();
    headersApplied = true;
    deps.applyOverride(channel);

    const check = await lease.native(deps.checkForUpdate);
    if (!check.isAvailable) {
      throw new Error(
        `No update on "${channel}" for runtime ${runtimeVersion}. Publish an OTA to that channel at this build's fingerprint first.`,
      );
    }

    await lease.native(deps.fetchUpdate);
    if (deps.canLaunchFetchedUpdate && !(await deps.canLaunchFetchedUpdate(lease))) {
      throw new Error('The downloaded update belongs to another update track.');
    }
    // Commit point: the update is downloaded and will launch on reload (or the next
    // cold start). From here a failure keeps the override rather than stranding it.
    committed = true;
    await lease.native(() => deps.writeMirror(channel).catch(deps.onMirrorError));
    if (deps.isFetchedUpdateCurrent && !deps.isFetchedUpdateCurrent()) {
      throw new Error('The pending update changed while preparing to restart.');
    }
    await lease.reload(deps.reload);
    return { status: 'switched' };
  } catch (error) {
    if (committed) {
      return { status: 'pending-restart' };
    }
    if (headersApplied) await restoreChannel(previousOverride, deps, lease);
    return { status: 'reverted', error };
  }
}

export type ChannelResetResult =
  | { status: 'reset' }
  | { status: 'pending-restart' }
  | { status: 'failed'; error: unknown };

/**
 * Clear the channel override and return to the build-time channel. Mirrors
 * performChannelSwitch's commit discipline: the mirror is only cleared once we're
 * committed to reloading, and a pre-commit failure re-applies the previous override
 * AND restores the mirror to it, so the display never diverges from the native state.
 */
export async function performChannelReset(
  previousOverride: string | null,
  deps: ChannelSwitchDeps,
  options?: OtaOperationOptions,
): Promise<ChannelResetResult> {
  return runOtaOperation((lease) => resetChannelOwned(previousOverride, deps, lease), {
    timeoutMs: CHANNEL_SWITCH_TIMEOUT_MS,
    ...options,
  }).catch((error: unknown) => ({ status: 'failed', error }));
}

async function resetChannelOwned(
  previousOverride: string | null,
  deps: ChannelSwitchDeps,
  lease: OtaOperationLease,
): Promise<ChannelResetResult> {
  let committed = false;
  let headersApplied = false;
  try {
    await deps.waitForIdle?.(lease);
    lease.assertActive();
    headersApplied = true;
    deps.applyOverride(null);

    const check = await lease.native(deps.checkForUpdate);
    if (check.isAvailable) {
      await lease.native(deps.fetchUpdate);
      if (deps.canLaunchFetchedUpdate && !(await deps.canLaunchFetchedUpdate(lease))) {
        throw new Error('The downloaded update belongs to another update track.');
      }
    }
    committed = true;
    await lease.native(() => deps.clearMirror().catch(deps.onMirrorError));
    if (check.isAvailable && deps.isFetchedUpdateCurrent && !deps.isFetchedUpdateCurrent()) {
      throw new Error('The pending update changed while preparing to restart.');
    }
    await lease.reload(deps.reload);
    return { status: 'reset' };
  } catch (error) {
    if (committed) {
      return { status: 'pending-restart' };
    }
    if (headersApplied) await restoreChannel(previousOverride, deps, lease);
    return { status: 'failed', error };
  }
}

async function restoreChannel(
  previousOverride: string | null,
  deps: ChannelSwitchDeps,
  lease: OtaOperationLease,
): Promise<void> {
  try {
    deps.applyOverride(previousOverride);
    await (previousOverride ? deps.writeMirror(previousOverride) : deps.clearMirror()).catch(deps.onMirrorError);
  } catch (error) {
    lease.quarantine(error);
    throw error;
  }
}
