// Pure orchestration for the tester OTA channel switcher. All platform I/O
// (expo-updates, AsyncStorage mirror, telemetry) is injected so the commit/revert
// state machine can be unit-tested without a rendered component or native modules.
// The screen (ChannelSwitcherScreen.tsx) is a thin UI layer over this.

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
  // Override the build's `expo-channel-name` request header (null clears it).
  applyOverride: (channel: string | null) => void;
  checkForUpdate: () => Promise<{ isAvailable: boolean }>;
  fetchUpdate: () => Promise<unknown>;
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
): Promise<ChannelSwitchResult> {
  let committed = false;
  try {
    deps.applyOverride(channel);

    const check = await deps.checkForUpdate();
    if (!check.isAvailable) {
      throw new Error(
        `No update on "${channel}" for runtime ${runtimeVersion}. Publish an OTA to that channel at this build's fingerprint first.`,
      );
    }

    await deps.fetchUpdate();
    // Commit point: the update is downloaded and will launch on reload (or the next
    // cold start). From here a failure keeps the override rather than stranding it.
    committed = true;
    await deps.writeMirror(channel).catch(deps.onMirrorError);
    await deps.reload();
    return { status: 'switched' };
  } catch (error) {
    if (committed) {
      return { status: 'pending-restart' };
    }
    deps.applyOverride(previousOverride);
    await (previousOverride ? deps.writeMirror(previousOverride) : deps.clearMirror()).catch(deps.onMirrorError);
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
): Promise<ChannelResetResult> {
  let committed = false;
  try {
    deps.applyOverride(null);

    const check = await deps.checkForUpdate();
    if (check.isAvailable) {
      await deps.fetchUpdate();
    }
    committed = true;
    await deps.clearMirror().catch(deps.onMirrorError);
    await deps.reload();
    return { status: 'reset' };
  } catch (error) {
    if (committed) {
      return { status: 'pending-restart' };
    }
    deps.applyOverride(previousOverride);
    await (previousOverride ? deps.writeMirror(previousOverride) : deps.clearMirror()).catch(deps.onMirrorError);
    return { status: 'failed', error };
  }
}
