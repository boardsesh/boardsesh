import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { Alert } from 'react-native';
import { useTranslation } from 'react-i18next';
import * as Updates from 'expo-updates';
import { reportError, reportHandledError } from '../lib/error-reporting';
import { isSentryEnabled, nativeSentryCrash } from '../lib/sentry';
import { useOtaPreviewChannels, useProfile } from '../lib/graphql/hooks';
import { useConfirm } from '../providers/dialog-provider';
import { hapticLight, hapticError } from '../lib/haptics';
import { getPreference, setPreference, removePreference } from '../lib/preference-store';
import { applyChannelOverride } from '../lib/apply-channel-override';
import {
  OTA_CHANNEL_OVERRIDE_KEY,
  buildChannelList,
  resolveBuildChannel,
  performChannelSwitch,
  performChannelReset,
  type ChannelSwitchDeps,
} from '../lib/channel-switch';
import { SwitcherForm } from './SwitcherForm';
import { deriveSwitchRowState, isSwitchRowPressable } from './SwitcherForm.logic';
import type { SwitcherFormModel, SwitcherRow, SwitcherSection } from './SwitcherForm.types';

// Stable empty fallback so `previewQuery.data ?? […]` doesn't hand the model
// `useMemo` a fresh array reference on every render while the query is loading
// (which would rebuild the whole form model each render). React-query returns a
// stable `data` ref once resolved.
const EMPTY_PREVIEW_CHANNELS: NonNullable<ReturnType<typeof useOtaPreviewChannels>['data']> = [];

type ChannelSwitcherScreenProps = {
  // Channel the user arrived on via the /preview/<channel> deep link in a PR's
  // OTA-preview comment. Already validated by parsePreviewChannel. Offered once,
  // through the same confirm dialog a tapped row uses.
  requestedChannel?: string;
};

// The OTA preview-channel switcher, rendered as a single native @expo/ui form
// (SwiftUI `Form` on iOS, Jetpack Compose `LazyColumn` on Android) via the shared
// <SwitcherForm />. This component owns every hook, route data, `t()` call,
// confirm dialog, Alert, haptic, and the `channel-switch.ts` state machine, then
// builds a plain view-model the native tree renders. Mirrors the
// FeatureFlagsScreen → FeatureFlagsForm split.
export function ChannelSwitcherScreen({ requestedChannel }: ChannelSwitcherScreenProps) {
  const { t } = useTranslation('common');
  const confirm = useConfirm();
  const { data: profile } = useProfile();
  // Live per-PR preview channels (with titles) from the backend. Public query —
  // works for signed-out users too. Fail-soft: the backend returns [] on error,
  // so isError is rare; we still handle it for completeness.
  const previewQuery = useOtaPreviewChannels();
  const previewChannels = previewQuery.data ?? EMPTY_PREVIEW_CHANNELS;
  // Channel switching (preview list, preset list, manual entry) is available to
  // everyone; only the Sentry crash-test tools stay tester-only.
  const isTester = Boolean(profile?.isTester);

  const [override, setOverride] = useState<string | null>(null);
  // Whether the stored override has been read back. The deep-link auto-offer
  // waits on this: switchToChannel captures overrideRef.current as the channel to
  // revert to, so firing before the load lands would revert to the wrong one.
  const [overrideLoaded, setOverrideLoaded] = useState(false);
  const [customChannel, setCustomChannel] = useState('');
  const [switchingChannel, setSwitchingChannel] = useState<string | null>(null);
  // Synchronous re-entrancy guard: `switchingChannel` only updates after the async
  // confirm dialog resolves, so a ref blocks a second switch starting while the
  // dialog (or an in-flight switch) is open.
  const inFlightRef = useRef(false);
  // Mirror of `override` for the imperative revert path — reading the latest value
  // from a ref avoids reverting to a stale render-closure value if the mount load
  // resolved after this callback was created.
  const overrideRef = useRef<string | null>(null);
  // One-shot guard for the deep-link offer, so the re-renders the switch itself
  // causes can't re-raise the dialog.
  const offeredRequestRef = useRef(false);

  useEffect(() => {
    let active = true;
    void getPreference<string>(OTA_CHANNEL_OVERRIDE_KEY)
      .then((stored) => {
        if (active) setOverride(stored);
      })
      .catch(reportHandledError)
      .finally(() => {
        // Either way the read is done — a failed mirror read means "no override",
        // which is what the null initial state already says. Unblock the offer.
        if (active) setOverrideLoaded(true);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    overrideRef.current = override;
  }, [override]);

  const runtimeVersion = Updates.runtimeVersion ?? 'unknown';
  const updatesUsable = Updates.isEnabled && !__DEV__;
  // Real builds always bake a channel (production for store/TestFlight), but
  // expo-updates can report it as null on device — notably Android — so resolve
  // to production there. In dev there's genuinely no channel, so stay honest with
  // "unknown" rather than mislabel the debug info row as production.
  const buildChannel = updatesUsable ? resolveBuildChannel(Updates.channel) : (Updates.channel ?? 'unknown');
  const isSwitching = switchingChannel !== null;

  // A channel is "active" when it's the live override, or — with no override —
  // when it matches the build-time channel.
  const activeChannel = override ?? buildChannel;

  const makeDeps = useCallback(
    (): ChannelSwitchDeps => ({
      applyOverride: applyChannelOverride,
      checkForUpdate: () => Updates.checkForUpdateAsync(),
      fetchUpdate: () => Updates.fetchUpdateAsync(),
      reload: () => Updates.reloadAsync(),
      writeMirror: (channel) => setPreference(OTA_CHANNEL_OVERRIDE_KEY, channel),
      clearMirror: () => removePreference(OTA_CHANNEL_OVERRIDE_KEY),
      onMirrorError: reportHandledError,
    }),
    [],
  );

  // `label` is the human-friendly name shown in the confirm/alert copy (a PR
  // title for preview rows; the raw channel for the tester preset/custom rows).
  const switchToChannel = useCallback(
    async (channel: string, label: string = channel) => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      const previousOverride = overrideRef.current;
      try {
        hapticLight();
        const confirmed = await confirm({
          title: t('mobile.previewChannels.confirmSwitchTitle'),
          message: t('mobile.previewChannels.confirmSwitchMessage', { label }),
          confirmLabel: t('mobile.previewChannels.confirmSwitchConfirm'),
          cancelLabel: t('mobile.previewChannels.cancel'),
        });
        if (!confirmed) return;

        setSwitchingChannel(channel);
        const result = await performChannelSwitch(channel, previousOverride, runtimeVersion, makeDeps());
        if (result.status === 'reverted') {
          hapticError();
          Alert.alert(
            t('mobile.previewChannels.switchFailedTitle'),
            result.error instanceof Error ? result.error.message : t('mobile.previewChannels.switchFailedFallback'),
          );
        } else {
          // 'switched' (the app reloads) or 'pending-restart' — reflect the new channel.
          setOverride(channel);
          if (result.status === 'pending-restart') {
            Alert.alert(
              t('mobile.previewChannels.restartTitle'),
              t('mobile.previewChannels.restartSwitchMessage', { label }),
            );
          }
        }
      } finally {
        setSwitchingChannel(null);
        inFlightRef.current = false;
      }
    },
    [confirm, runtimeVersion, makeDeps, t],
  );

  // Deep link (/preview/<channel>): offer the linked channel as soon as we know
  // enough to do it well. This goes through switchToChannel, so the same confirm
  // dialog a tapped row raises still gates it — a link never switches the app on
  // its own.
  useEffect(() => {
    if (offeredRequestRef.current || !requestedChannel || !overrideLoaded) return;
    // Wait for the preview list so the dialog can name the PR ("Load “Fix the
    // queue jump”…") rather than the bare channel. isLoading goes false on error
    // too, so a failed list degrades to the channel name instead of hanging.
    if (previewQuery.isLoading) return;

    offeredRequestRef.current = true;
    if (!updatesUsable) {
      // Metro / Expo Go: switching is inert, so prefill the manual field instead
      // of raising a dialog that can't go anywhere. The section footer already
      // explains why nothing is tappable.
      setCustomChannel(requestedChannel);
      return;
    }
    if (requestedChannel === activeChannel) return;
    const title = previewChannels.find((preview) => preview.channel === requestedChannel)?.title;
    void switchToChannel(requestedChannel, title ?? requestedChannel);
  }, [
    requestedChannel,
    overrideLoaded,
    previewQuery.isLoading,
    previewChannels,
    updatesUsable,
    activeChannel,
    switchToChannel,
  ]);

  const resetToBuildChannel = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    const previousOverride = overrideRef.current;
    try {
      hapticLight();
      const confirmed = await confirm({
        title: t('mobile.previewChannels.confirmResetTitle', { channel: buildChannel }),
        message: t('mobile.previewChannels.confirmResetMessage', { channel: buildChannel }),
        confirmLabel: t('mobile.previewChannels.confirmResetConfirm'),
        cancelLabel: t('mobile.previewChannels.cancel'),
      });
      if (!confirmed) return;

      setSwitchingChannel(buildChannel);
      const result = await performChannelReset(previousOverride, makeDeps());
      if (result.status === 'failed') {
        hapticError();
        // The override was re-applied on the failed reset, so the build is still on the
        // previous channel (or the build channel if there was no override). Say so.
        const stayedOn = previousOverride ?? buildChannel;
        const reason =
          result.error instanceof Error ? result.error.message : t('mobile.previewChannels.resetFailedReason');
        Alert.alert(
          t('mobile.previewChannels.resetFailedTitle'),
          t('mobile.previewChannels.resetFailedMessage', { reason, channel: stayedOn }),
        );
      } else {
        setOverride(null);
        if (result.status === 'pending-restart') {
          Alert.alert(
            t('mobile.previewChannels.restartTitle'),
            t('mobile.previewChannels.restartResetMessage', { channel: buildChannel }),
          );
        }
      }
    } finally {
      setSwitchingChannel(null);
      inFlightRef.current = false;
    }
  }, [confirm, buildChannel, makeDeps, t]);

  // --- Sentry verification (tester-only) ---
  // Sentry never sends from a dev / Metro build (gated on !__DEV__), so the only
  // way to confirm the deployed binary actually reports is to fire each capture
  // path from a real build and watch the boardsesh Sentry project.
  const sendSentryTestEvent = useCallback(() => {
    hapticLight();
    reportError(new Error('Sentry test event (handled) — channel switcher'), {
      tags: { source: 'sentry-test', kind: 'handled' },
    });
    Alert.alert(
      // i18n-ignore-next-line — tester-only screen
      'Test event sent',
      isSentryEnabled
        ? // i18n-ignore-next-line — tester-only screen
          'A handled event was sent to the boardsesh Sentry project. Filter by source:sentry-test.'
        : // i18n-ignore-next-line — tester-only screen
          'Sentry is disabled in this build, so nothing was sent.',
    );
  }, []);

  const throwSentryUncaught = useCallback(() => {
    hapticError();
    // Throw on a fresh tick so it escapes this handler and React, surfacing as a
    // genuine uncaught JS error that the global handler reports to Sentry.
    setTimeout(() => {
      throw new Error('Sentry test: uncaught JS exception — channel switcher');
    }, 0);
  }, []);

  const triggerSentryNativeCrash = useCallback(async () => {
    hapticLight();
    const confirmed = await confirm({
      // i18n-ignore-next-line — tester-only screen
      title: 'Force a native crash?',
      // i18n-ignore-next-line — tester-only screen
      message: 'The app crashes immediately. The crash uploads to Sentry on the next launch.',
      // i18n-ignore-next-line — tester-only screen
      confirmLabel: 'Crash',
      // i18n-ignore-next-line — tester-only screen
      cancelLabel: 'Cancel',
    });
    if (!confirmed) return;
    hapticError();
    nativeSentryCrash();
  }, [confirm]);

  // Build the native form's view-model. Memoized so the Host's children don't
  // rebuild every render; derived lists (preset channels, the active channel) are
  // computed inside so the dep set stays referentially stable.
  const model = useMemo<SwitcherFormModel>(() => {
    const sections: SwitcherSection[] = [];

    // Current channel info — the "updates unavailable" notice rides the footer.
    sections.push({
      key: 'current',
      title: t('mobile.previewChannels.currentSection'),
      footer: updatesUsable ? undefined : t('mobile.previewChannels.unavailableNotice'),
      rows: [
        { kind: 'info', key: 'build', label: t('mobile.previewChannels.buildChannelLabel'), value: buildChannel },
        {
          kind: 'info',
          key: 'selected',
          label: t('mobile.previewChannels.selectedChannelLabel'),
          value: override ?? t('mobile.previewChannels.defaultValue', { channel: buildChannel }),
        },
        {
          kind: 'info',
          key: 'runtime',
          label: t('mobile.previewChannels.runtimeVersionLabel'),
          value: runtimeVersion,
        },
      ],
    });

    // Friendly per-PR preview list — shown to everyone. Rows stay inert (rendered
    // but not tappable) when switching is unavailable so the list can be reviewed.
    const previewRows: SwitcherRow[] = [];

    // Fixed production row first. Production is the stable release — never in the
    // backend preview list (that's only open PRs) — so it's surfaced as a fixed row
    // everyone can tap to get back. Tapping runs the reset flow, which clears the
    // override and returns to the baked-in production channel.
    const productionState = deriveSwitchRowState({
      target: buildChannel,
      activeTarget: activeChannel,
      switchingTarget: switchingChannel,
      updatesUsable,
    });
    previewRows.push({
      kind: 'target',
      key: 'production',
      title: t('mobile.previewChannels.productionTitle'),
      subtitle: t('mobile.previewChannels.productionSubtitle'),
      state: productionState,
      showChevronWhenPressable: true,
      onPress: isSwitchRowPressable(productionState) ? () => void resetToBuildChannel() : undefined,
    });

    if (previewQuery.isLoading) {
      previewRows.push({ kind: 'status', key: 'loading', label: t('mobile.previewChannels.loading'), busy: true });
    } else if (previewQuery.isError) {
      previewRows.push({ kind: 'status', key: 'error', label: t('mobile.previewChannels.error') });
    } else if (previewChannels.length === 0) {
      previewRows.push({ kind: 'status', key: 'empty', label: t('mobile.previewChannels.empty') });
    } else {
      for (const preview of previewChannels) {
        const state = deriveSwitchRowState({
          target: preview.channel,
          activeTarget: activeChannel,
          switchingTarget: switchingChannel,
          updatesUsable,
        });
        previewRows.push({
          kind: 'target',
          key: preview.channel,
          title: preview.title,
          subtitle: preview.channel,
          state,
          showChevronWhenPressable: true,
          onPress: isSwitchRowPressable(state) ? () => void switchToChannel(preview.channel, preview.title) : undefined,
        });
      }
    }
    sections.push({
      key: 'preview',
      title: t('mobile.previewChannels.listSection'),
      intro: t('mobile.previewChannels.intro'),
      rows: previewRows,
    });

    if (updatesUsable) {
      // Preset channels (preview-1…4) — available to everyone, not just testers.
      // The build channel (production) is filtered out since the fixed Production
      // row above already covers it. Raw channel names, no chevron.
      const presetChannels = buildChannelList(override).filter((channel) => channel !== buildChannel);
      if (presetChannels.length > 0) {
        sections.push({
          key: 'preset',
          title: t('mobile.previewChannels.presetSection'),
          rows: presetChannels.map((channel) => {
            const state = deriveSwitchRowState({
              target: channel,
              activeTarget: activeChannel,
              switchingTarget: switchingChannel,
              updatesUsable,
            });
            return {
              kind: 'target',
              key: channel,
              title: channel,
              state,
              showChevronWhenPressable: false,
              onPress: isSwitchRowPressable(state) ? () => void switchToChannel(channel) : undefined,
            };
          }),
        });
      }

      // Free-text channel entry — available to everyone, so any user can switch to
      // any channel (not just the previews/presets above). The hint only appears
      // when the preview list failed to load.
      {
        const trimmed = customChannel.trim();
        const submitManual = () => {
          const value = customChannel.trim();
          if (value) void switchToChannel(value);
        };
        sections.push({
          key: 'manual',
          title: t('mobile.previewChannels.manualSection'),
          intro: previewQuery.isError ? t('mobile.previewChannels.manualHint') : undefined,
          rows: [
            {
              kind: 'field',
              key: 'manual-field',
              label: t('mobile.previewChannels.manualInputA11y'),
              placeholder: t('mobile.previewChannels.manualPlaceholder'),
              value: customChannel,
              onChangeText: setCustomChannel,
              onSubmit: submitManual,
              editable: !isSwitching,
            },
            {
              kind: 'action',
              key: 'manual-switch',
              label: t('mobile.previewChannels.confirmSwitchConfirm'),
              icon: 'switch',
              disabled: isSwitching || trimmed.length === 0,
              onPress: submitManual,
            },
          ],
        });
      }

      // Reset — available to everyone, kept last as the escape hatch back to the
      // shipped version. Not gated on `override` so a native override stranded
      // after an app-data clear stays clearable.
      sections.push({
        key: 'reset',
        rows: [
          {
            kind: 'action',
            key: 'reset',
            label: t('mobile.previewChannels.reset', { channel: buildChannel }),
            icon: 'reset',
            disabled: isSwitching,
            onPress: () => void resetToBuildChannel(),
          },
        ],
      });
    }

    // Sentry verification (tester-only).
    if (isTester) {
      sections.push({
        key: 'sentry',
        // i18n-ignore-next-line — tester-only screen
        title: 'Test crash reporting (Sentry)',
        rows: [
          {
            kind: 'info',
            key: 'sentry-status',
            // i18n-ignore-next-line — tester-only screen
            label: 'Sentry',
            // i18n-ignore-next-line — tester-only screen
            value: isSentryEnabled ? 'Active' : 'Disabled in this build',
          },
          {
            kind: 'action',
            key: 'sentry-handled',
            // i18n-ignore-next-line — tester-only screen
            label: 'Send test event (handled)',
            icon: 'send',
            onPress: sendSentryTestEvent,
          },
          {
            kind: 'action',
            key: 'sentry-uncaught',
            // i18n-ignore-next-line — tester-only screen
            label: 'Throw JS exception (uncaught)',
            icon: 'warning',
            onPress: throwSentryUncaught,
          },
          {
            kind: 'action',
            key: 'sentry-native',
            // i18n-ignore-next-line — tester-only screen
            label: 'Native crash',
            icon: 'flame',
            onPress: () => void triggerSentryNativeCrash(),
          },
        ],
      });
    }

    return { sections };
  }, [
    t,
    buildChannel,
    override,
    runtimeVersion,
    updatesUsable,
    activeChannel,
    switchingChannel,
    isSwitching,
    isTester,
    customChannel,
    previewQuery.isLoading,
    previewQuery.isError,
    previewChannels,
    switchToChannel,
    resetToBuildChannel,
    sendSentryTestEvent,
    throwSentryUncaught,
    triggerSentryNativeCrash,
  ]);

  return <SwitcherForm model={model} />;
}
