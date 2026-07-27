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

// Production binaries bake EXPO_UPDATES_CHANNEL=production, but expo-updates can
// report Updates.channel as null on device (notably Android). Fall back to the
// production channel so the build-channel label and active-channel detection stay
// correct — otherwise users see "unknown" and can't tell the way back to production.
// This is a display/label default only: the switcher gates every actual switch on
// `updatesUsable` (Updates.isEnabled && !__DEV__), so only real store/TestFlight
// binaries — which always bake the channel — ever act on it.
//
// Assumption: a real build that reports a null channel was built for production.
// Today that always holds (only production store/TestFlight binaries ship). If we
// ever ship a binary that bakes a non-production channel (e.g. a `staging` build)
// AND it hits the Android null-channel bug, this would mislabel it as production —
// revisit this default if that ever becomes possible.
export function resolveBuildChannel(channel: string | null | undefined): string {
  // `||` (not `??`) so an empty-string channel also falls back to production.
  return channel || 'production';
}

// Per-row UI state for a channel in the switcher list, shared by the fixed
// production row and the preview / tester-preset rows so the active-checkmark,
// in-flight-spinner, and pressability rules stay identical and unit-testable.
export type ChannelRowState = {
  // This channel is the one the build is currently on (live override, or the
  // build channel when there's no override) — show a checkmark, don't switch.
  isActive: boolean;
  // A switch onto THIS channel is in flight — show a spinner.
  isSwitching: boolean;
  // A switch onto a DIFFERENT channel is in flight — dim and block this row.
  isDisabled: boolean;
  // The row should respond to taps (switching is available and the row is
  // neither already active nor blocked by another in-flight switch).
  isPressable: boolean;
};

export function deriveChannelRowState(params: {
  channel: string;
  activeChannel: string;
  switchingChannel: string | null;
  updatesUsable: boolean;
}): ChannelRowState {
  const { channel, activeChannel, switchingChannel, updatesUsable } = params;
  const isActive = channel === activeChannel;
  const isSwitching = switchingChannel === channel;
  const isDisabled = switchingChannel !== null && !isSwitching;
  // Not pressable while already active, blocked by another switch, or mid-switch
  // onto this same channel (it's showing a spinner).
  const isPressable = updatesUsable && !isActive && !isDisabled && !isSwitching;
  return { isActive, isSwitching, isDisabled, isPressable };
}

// What the screen should do about a channel it was deep-linked to
// (/preview/<channel>, the link in every PR's OTA-preview comment).
export type RequestedChannelAction =
  // Not enough known yet — the stored override or the preview list is still
  // loading. Ask again on the next render; do NOT mark the request as handled.
  | 'wait'
  // Offer the switch (through the confirm dialog, same as a tapped row).
  | 'switch'
  // Switching is inert (Metro / Expo Go), so put the channel in the manual field
  // rather than raising a dialog that can't go anywhere.
  | 'prefill'
  // Nothing to do: no request, already handled, or already on that channel.
  | 'none';

/**
 * Decide what a deep-linked channel request should trigger. Extracted from the
 * screen because the component test can't reach the interesting branches: the
 * mobile vitest config inlines `__DEV__: true` as a build-time `define`, so
 * `updatesUsable` is false in every rendered test and 'switch' is unreachable
 * there. Taking `updatesUsable` as a parameter puts every branch under test.
 *
 * Order matters. 'wait' must be distinguishable from 'none' so the caller only
 * burns its one-shot guard once it has actually acted.
 */
export function resolveRequestedChannelAction(params: {
  requestedChannel: string | undefined;
  // The channel the caller last acted on, or null. Keyed by channel rather than a
  // lifetime boolean: Expo Router can swap the param on a still-mounted preview
  // screen when a second /preview/pr-M link is opened, and a boolean guard would
  // swallow every channel after the first.
  offeredChannel: string | null;
  // The stored override has been read back. Switching before this lands would
  // capture the wrong `previousOverride` to revert to.
  overrideLoaded: boolean;
  // The backend preview list is still in flight. Waiting lets the confirm dialog
  // name the PR instead of the bare channel.
  previewsLoading: boolean;
  updatesUsable: boolean;
  activeChannel: string;
}): RequestedChannelAction {
  const { requestedChannel, offeredChannel, overrideLoaded, previewsLoading, updatesUsable, activeChannel } = params;
  if (!requestedChannel || offeredChannel === requestedChannel) return 'none';
  if (!overrideLoaded || previewsLoading) return 'wait';
  if (!updatesUsable) return 'prefill';
  return requestedChannel === activeChannel ? 'none' : 'switch';
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
