import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { Alert } from 'react-native';
import * as Updates from 'expo-updates';
import { useConfirm } from '../providers/dialog-provider';
import { hapticLight, hapticError } from '../lib/haptics';
import { reportHandledError } from '../lib/error-reporting';
import { getPreference, setPreference, removePreference } from '../lib/preference-store';
import { applyChannelOverride } from '../lib/apply-channel-override';
import {
  OTA_CHANNEL_OVERRIDE_KEY,
  buildChannelList,
  performChannelSwitch,
  performChannelReset,
  type ChannelSwitchDeps,
} from '../lib/channel-switch';
import { isPreviewBuild } from '../lib/preview-build';
import { checkForOtaUpdate, fetchOtaUpdate } from '../lib/ota-network';
import { SwitcherForm } from './SwitcherForm';
import { deriveSwitchRowState, isSwitchRowPressable } from './SwitcherForm.logic';
import type { SwitcherFormModel, SwitcherRow, SwitcherSection } from './SwitcherForm.types';

// The branch baked into the running update's manifest metadata (set by the OTA
// server). Read-only and tokenless — surfaced so a tester can see which branch
// they're on before switching.
function getCurrentBranchName(): string | null {
  const manifest = Updates.manifest;
  if (!manifest || typeof manifest !== 'object') return null;

  if ('metadata' in manifest) {
    const metadata = (manifest as { metadata?: Record<string, unknown> }).metadata;
    if (metadata && typeof metadata.branchName === 'string') {
      return metadata.branchName;
    }
  }

  return null;
}

// EAS preview-build branch switcher, rendered as a single native @expo/ui form via
// the shared <SwitcherForm />. It repoints the running build at a different update
// target device-locally by overriding `expo-channel-name`, using the commit/revert
// state machine in `channel-switch.ts`. A tester picks a preview channel/branch (or types one) and the
// build pulls that branch's OTA on restart. Tester-only, so copy is `i18n-ignore`d.
export function BranchSwitcherScreen() {
  const confirm = useConfirm();
  const [override, setOverride] = useState<string | null>(null);
  const [customBranch, setCustomBranch] = useState('');
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  // Synchronous re-entrancy guard: `switchingTo` only updates after the async
  // confirm dialog resolves, so a ref blocks a second switch starting while the
  // dialog (or an in-flight switch) is open.
  const inFlightRef = useRef(false);
  // Mirror of `override` for the imperative revert path — reading the latest value
  // from a ref avoids reverting to a stale render-closure value if the mount load
  // resolved after a callback was created.
  const overrideRef = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    void getPreference<string>(OTA_CHANNEL_OVERRIDE_KEY).then((stored) => {
      if (active) setOverride(stored);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    overrideRef.current = override;
  }, [override]);

  const preview = isPreviewBuild();
  const buildChannel = Updates.channel ?? 'unknown';
  const currentBranch = getCurrentBranchName();
  const currentUpdateId = Updates.updateId ?? null;
  const runtimeVersion = Updates.runtimeVersion ?? 'unknown';
  const isEmbedded = Updates.isEmbeddedLaunch;
  const updatesUsable = Updates.isEnabled && !__DEV__;
  const isSwitching = switchingTo !== null;
  // The branch/channel currently targeted: the live override, else the build channel.
  const activeTarget = override ?? buildChannel;

  const makeDeps = useCallback(
    (): ChannelSwitchDeps => ({
      applyOverride: applyChannelOverride,
      checkForUpdate: checkForOtaUpdate,
      fetchUpdate: fetchOtaUpdate,
      reload: () => Updates.reloadAsync(),
      writeMirror: (channel) => setPreference(OTA_CHANNEL_OVERRIDE_KEY, channel),
      clearMirror: () => removePreference(OTA_CHANNEL_OVERRIDE_KEY),
      onMirrorError: reportHandledError,
    }),
    [],
  );

  const switchToBranch = useCallback(
    async (branch: string) => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      const previousOverride = overrideRef.current;
      try {
        hapticLight();
        const confirmed = await confirm({
          // i18n-ignore-next-line — preview-only dev screen
          title: 'Switch branch',
          // i18n-ignore-next-line
          message: `Pull the latest update from "${branch}" and restart? It must have an update published for this build's fingerprint.`,
          // i18n-ignore-next-line
          confirmLabel: 'Switch',
          // i18n-ignore-next-line
          cancelLabel: 'Cancel',
        });
        if (!confirmed) return;

        setSwitchingTo(branch);
        const result = await performChannelSwitch(branch, previousOverride, runtimeVersion, makeDeps());
        if (result.status === 'reverted') {
          hapticError();
          Alert.alert(
            // i18n-ignore-next-line
            'Switch failed',
            result.error instanceof Error
              ? result.error.message
              : // i18n-ignore-next-line
                'Could not switch branch. This build may not support OTA overrides.',
          );
        } else {
          // 'switched' (the app reloads) or 'pending-restart' — reflect the new branch.
          setOverride(branch);
          if (result.status === 'pending-restart') {
            // i18n-ignore-next-line
            Alert.alert('Restart to finish', `Downloaded "${branch}". Restart the app to switch onto it.`);
          }
        }
      } finally {
        setSwitchingTo(null);
        inFlightRef.current = false;
      }
    },
    [confirm, runtimeVersion, makeDeps],
  );

  const resetToBuildBranch = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    const previousOverride = overrideRef.current;
    try {
      hapticLight();
      const confirmed = await confirm({
        // i18n-ignore-next-line
        title: 'Reset to build branch',
        // i18n-ignore-next-line
        message: `Clear the override and return to "${buildChannel}"? The app will restart.`,
        // i18n-ignore-next-line
        confirmLabel: 'Reset',
        // i18n-ignore-next-line
        cancelLabel: 'Cancel',
      });
      if (!confirmed) return;

      setSwitchingTo(buildChannel);
      const result = await performChannelReset(previousOverride, makeDeps());
      if (result.status === 'failed') {
        hapticError();
        const stayedOn = previousOverride ?? buildChannel;
        const reason = result.error instanceof Error ? result.error.message : 'Could not reset branch.';
        // i18n-ignore-next-line
        Alert.alert('Reset failed', `${reason} Stayed on "${stayedOn}".`);
      } else {
        setOverride(null);
        if (result.status === 'pending-restart') {
          // i18n-ignore-next-line
          Alert.alert('Restart to finish', `Cleared the override. Restart the app to return to "${buildChannel}".`);
        }
      }
    } finally {
      setSwitchingTo(null);
      inFlightRef.current = false;
    }
  }, [confirm, buildChannel, makeDeps]);

  // Build the native form's view-model. Memoized so the Host's children don't
  // rebuild every render; `branches` is derived inside so the dep set stays stable.
  const model = useMemo<SwitcherFormModel>(() => {
    const sections: SwitcherSection[] = [];

    // Current update info. Conditional rows mirror the original card.
    const currentRows: SwitcherRow[] = [];
    if (isEmbedded) {
      // i18n-ignore-next-line
      currentRows.push({ kind: 'info', key: 'status', label: 'Status', value: 'No OTA update applied' });
    }
    // i18n-ignore-next-line
    currentRows.push({ kind: 'info', key: 'build', label: 'Build channel', value: buildChannel });
    currentRows.push({
      kind: 'info',
      key: 'selected',
      // i18n-ignore-next-line
      label: 'Selected branch',
      // i18n-ignore-next-line
      value: override ?? `${buildChannel} (default)`,
    });
    if (currentBranch) {
      // i18n-ignore-next-line
      currentRows.push({ kind: 'info', key: 'running', label: 'Running branch', value: currentBranch });
    }
    if (currentUpdateId) {
      // i18n-ignore-next-line
      currentRows.push({ kind: 'info', key: 'update-id', label: 'Update ID', value: currentUpdateId.slice(0, 8) });
    }
    // i18n-ignore-next-line
    currentRows.push({ kind: 'info', key: 'runtime', label: 'Runtime version', value: runtimeVersion });
    sections.push({
      key: 'current',
      // i18n-ignore-next-line
      title: 'Current Update',
      footer: updatesUsable
        ? undefined
        : // i18n-ignore-next-line
          'OTA updates are disabled in this build (development or updates not enabled), so branch switching is unavailable here.',
      rows: currentRows,
    });

    if (updatesUsable) {
      // Switch Branch — EAS preview channels/branches, no chevron.
      const branches = buildChannelList(override);
      sections.push({
        key: 'switch',
        // i18n-ignore-next-line
        title: 'Switch Branch',
        rows: branches.map((branch) => {
          const state = deriveSwitchRowState({
            target: branch,
            activeTarget,
            switchingTarget: switchingTo,
            updatesUsable,
          });
          return {
            kind: 'target',
            key: branch,
            title: branch,
            state,
            showChevronWhenPressable: false,
            onPress: isSwitchRowPressable(state) ? () => void switchToBranch(branch) : undefined,
          };
        }),
      });

      // Custom branch entry.
      const trimmedCustomBranch = customBranch.trim();
      const submitCustom = () => {
        const value = customBranch.trim();
        if (value) void switchToBranch(value);
      };
      sections.push({
        key: 'custom',
        // i18n-ignore-next-line
        title: 'Custom Branch',
        rows: [
          {
            kind: 'field',
            key: 'custom-field',
            // i18n-ignore-next-line
            label: 'Custom branch name',
            // i18n-ignore-next-line
            placeholder: 'branch name',
            value: customBranch,
            onChangeText: setCustomBranch,
            onSubmit: submitCustom,
            editable: !isSwitching,
          },
          {
            kind: 'action',
            key: 'custom-switch',
            // i18n-ignore-next-line
            label: 'Switch',
            icon: 'switch',
            disabled: isSwitching || trimmedCustomBranch.length === 0,
            onPress: submitCustom,
          },
        ],
      });

      // Reset — always offered (not gated on `override`) so a native override
      // stranded after an app-data clear stays clearable.
      sections.push({
        key: 'reset',
        rows: [
          {
            kind: 'action',
            key: 'reset',
            // i18n-ignore-next-line
            label: `Reset to build branch (${buildChannel})`,
            icon: 'reset',
            disabled: isSwitching,
            onPress: () => void resetToBuildBranch(),
          },
        ],
      });
    }

    return { sections };
  }, [
    buildChannel,
    override,
    currentBranch,
    currentUpdateId,
    runtimeVersion,
    isEmbedded,
    updatesUsable,
    activeTarget,
    switchingTo,
    isSwitching,
    customBranch,
    switchToBranch,
    resetToBuildBranch,
  ]);

  if (!preview) {
    return null;
  }

  return <SwitcherForm model={model} />;
}
