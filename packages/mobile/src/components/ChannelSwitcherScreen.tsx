import { useState, useCallback, useEffect, useRef } from 'react';
import { View, ScrollView, ActivityIndicator, Alert, Pressable, StyleSheet, TextInput } from 'react-native';
import { useTranslation } from 'react-i18next';
import * as Updates from 'expo-updates';
import { reportError, reportHandledError } from '../lib/error-reporting';
import { isSentryEnabled, nativeSentryCrash } from '../lib/sentry';
import { useOtaPreviewChannels, useProfile } from '../lib/graphql/hooks';
import { Text } from './Text';
import { SectionHeader } from './SectionHeader';
import { ListRow } from './ListRow';
import { Icon } from './Icon';
import { InfoRow } from './InfoRow';
import { useTheme } from '../providers/theme-provider';
import { useConfirm } from '../providers/dialog-provider';
import { hapticLight, hapticError } from '../lib/haptics';
import { getPreference, setPreference, removePreference } from '../lib/preference-store';
import { applyChannelOverride } from '../lib/apply-channel-override';
import {
  OTA_CHANNEL_OVERRIDE_KEY,
  buildChannelList,
  resolveBuildChannel,
  deriveChannelRowState,
  performChannelSwitch,
  performChannelReset,
  type ChannelSwitchDeps,
} from '../lib/channel-switch';

export function ChannelSwitcherScreen() {
  const { t } = useTranslation('common');
  const { systemColors, brandColors, spacing, borderRadius } = useTheme();
  const confirm = useConfirm();
  const { data: profile } = useProfile();
  // Live per-PR preview channels (with titles) from the backend. Public query —
  // works for signed-out users too. Fail-soft: the backend returns [] on error,
  // so isError is rare; we still handle it for completeness.
  const previewQuery = useOtaPreviewChannels();
  const previewChannels = previewQuery.data ?? [];
  // Channel switching (preview list, preset list, manual entry) is available to
  // everyone; only the Sentry crash-test tools stay tester-only.
  const isTester = Boolean(profile?.isTester);

  const [override, setOverride] = useState<string | null>(null);
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

  const runtimeVersion = Updates.runtimeVersion ?? 'unknown';
  const updatesUsable = Updates.isEnabled && !__DEV__;
  // Real builds always bake a channel (production for store/TestFlight), but
  // expo-updates can report it as null on device — notably Android — so resolve
  // to production there. In dev there's genuinely no channel, so stay honest with
  // "unknown" rather than mislabel the debug InfoRow as production.
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

  // The tester preset list excludes the build channel (production on real
  // builds) — it already has the dedicated production row below, so listing it
  // again here would duplicate it.
  const presetChannels = buildChannelList(override).filter((channel) => channel !== buildChannel);

  // Production is the stable release. It's never in the backend preview list
  // (that's only open PRs), so it's surfaced as a fixed first row everyone —
  // tester or not — can tap to get back. Tapping runs the reset flow, which
  // clears the override and returns to the baked-in production channel.
  const productionRow = deriveChannelRowState({
    channel: buildChannel,
    activeChannel,
    switchingChannel,
    updatesUsable,
  });

  const cardStyle = [
    styles.card,
    {
      backgroundColor: systemColors.secondaryBackground,
      borderRadius: borderRadius.lg,
      marginHorizontal: spacing[4],
    },
  ];

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic">
      <SectionHeader title={t('mobile.previewChannels.currentSection')} />
      <View style={cardStyle}>
        <InfoRow label={t('mobile.previewChannels.buildChannelLabel')} value={buildChannel} />
        <InfoRow
          label={t('mobile.previewChannels.selectedChannelLabel')}
          value={override ?? t('mobile.previewChannels.defaultValue', { channel: buildChannel })}
        />
        <InfoRow label={t('mobile.previewChannels.runtimeVersionLabel')} value={runtimeVersion} showSeparator={false} />
      </View>

      {!updatesUsable ? (
        <View style={[styles.notice, { marginHorizontal: spacing[4] }]}>
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            {t('mobile.previewChannels.unavailableNotice')}
          </Text>
        </View>
      ) : null}

      {/* Friendly per-PR preview list — shown to everyone. Rows are inert when
          switching is unavailable (dev / Expo Go) but still render so the list
          can be reviewed and screenshotted. */}
      <SectionHeader title={t('mobile.previewChannels.listSection')} />
      <Text
        variant="footnote"
        color={systemColors.secondaryLabel}
        style={[styles.intro, { marginHorizontal: spacing[4] }]}
      >
        {t('mobile.previewChannels.intro')}
      </Text>
      <View style={cardStyle}>
        {/* Fixed production row (see the productionRow derivation above). */}
        <ListRow
          title={t('mobile.previewChannels.productionTitle')}
          subtitle={t('mobile.previewChannels.productionSubtitle')}
          trailing={
            productionRow.isSwitching ? (
              <ActivityIndicator size="small" />
            ) : productionRow.isActive ? (
              <Icon name="check.small" size={20} color={systemColors.label} />
            ) : updatesUsable ? (
              <Icon name="chevron.right" size={16} color={systemColors.tertiaryLabel} />
            ) : null
          }
          onPress={productionRow.isPressable ? () => void resetToBuildChannel() : undefined}
          // Divide into whatever follows (spinner, error text, or rows); only
          // the bare empty-state notice reads better without a separator above it.
          showSeparator={previewQuery.isLoading || previewQuery.isError || previewChannels.length > 0}
          style={productionRow.isDisabled ? styles.disabledRow : undefined}
        />
        {previewQuery.isLoading ? (
          <View style={styles.statusRow}>
            <ActivityIndicator size="small" />
            <Text variant="footnote" color={systemColors.secondaryLabel}>
              {t('mobile.previewChannels.loading')}
            </Text>
          </View>
        ) : previewQuery.isError ? (
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.statusText}>
            {t('mobile.previewChannels.error')}
          </Text>
        ) : previewChannels.length === 0 ? (
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.statusText}>
            {t('mobile.previewChannels.empty')}
          </Text>
        ) : (
          previewChannels.map((preview, index) => {
            const row = deriveChannelRowState({
              channel: preview.channel,
              activeChannel,
              switchingChannel,
              updatesUsable,
            });
            const trailing = row.isSwitching ? (
              <ActivityIndicator size="small" />
            ) : row.isActive ? (
              <Icon name="check.small" size={20} color={systemColors.label} />
            ) : updatesUsable ? (
              <Icon name="chevron.right" size={16} color={systemColors.tertiaryLabel} />
            ) : null;
            return (
              <ListRow
                key={preview.channel}
                title={preview.title}
                subtitle={preview.channel}
                trailing={trailing}
                onPress={row.isPressable ? () => void switchToChannel(preview.channel, preview.title) : undefined}
                showSeparator={index < previewChannels.length - 1}
                style={row.isDisabled ? styles.disabledRow : undefined}
              />
            );
          })
        )}
      </View>

      {updatesUsable ? (
        <>
          {/* Preset channel list (preview-1…4) — available to everyone, not just
              testers. The build channel is filtered out above since the fixed
              Production row already covers it. */}
          {presetChannels.length > 0 ? (
            <>
              <SectionHeader title={t('mobile.previewChannels.presetSection')} />
              <View style={cardStyle}>
                {presetChannels.map((channel, index) => {
                  const row = deriveChannelRowState({ channel, activeChannel, switchingChannel, updatesUsable });
                  const trailing = row.isSwitching ? (
                    <ActivityIndicator size="small" />
                  ) : row.isActive ? (
                    <Icon name="check.small" size={20} color={systemColors.label} />
                  ) : null;

                  return (
                    <ListRow
                      key={channel}
                      title={channel}
                      trailing={trailing}
                      onPress={row.isPressable ? () => void switchToChannel(channel) : undefined}
                      showSeparator={index < presetChannels.length - 1}
                      style={row.isDisabled ? styles.disabledRow : undefined}
                    />
                  );
                })}
              </View>
            </>
          ) : null}

          {/* Free-text channel entry — available to everyone, so any user can
              switch to any channel (not just the previews/presets above). The
              hint only appears when the preview list failed to load. */}
          <SectionHeader title={t('mobile.previewChannels.manualSection')} />
          {previewQuery.isError ? (
            <Text
              variant="footnote"
              color={systemColors.secondaryLabel}
              style={[styles.intro, { marginHorizontal: spacing[4] }]}
            >
              {t('mobile.previewChannels.manualHint')}
            </Text>
          ) : null}
          <View style={[styles.customRow, { marginHorizontal: spacing[4] }]}>
            <TextInput
              value={customChannel}
              onChangeText={setCustomChannel}
              placeholder={t('mobile.previewChannels.manualPlaceholder')}
              placeholderTextColor={systemColors.secondaryLabel}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!isSwitching}
              accessibilityLabel={t('mobile.previewChannels.manualInputA11y')}
              style={[
                styles.input,
                {
                  color: systemColors.label,
                  backgroundColor: systemColors.secondaryBackground,
                  borderRadius: borderRadius.md,
                },
              ]}
            />
            <Pressable
              onPress={() => {
                const trimmed = customChannel.trim();
                if (trimmed) void switchToChannel(trimmed);
              }}
              disabled={isSwitching || customChannel.trim().length === 0}
              accessibilityRole="button"
              accessibilityLabel={t('mobile.previewChannels.manualSwitchA11y')}
              accessibilityState={{ disabled: isSwitching || customChannel.trim().length === 0 }}
              style={[
                styles.goButton,
                {
                  backgroundColor: systemColors.tertiaryBackground,
                  borderRadius: borderRadius.md,
                  opacity: isSwitching || customChannel.trim().length === 0 ? 0.5 : 1,
                },
              ]}
            >
              <Icon name="transfer" size={16} color={systemColors.label} />
              <Text variant="footnote" color={systemColors.label}>
                {t('mobile.previewChannels.confirmSwitchConfirm')}
              </Text>
            </Pressable>
          </View>

          {/* Reset — available to everyone, kept last as the escape hatch back to
              the shipped version. Not gated on `override` so a native override
              stranded after an app-data clear stays clearable. */}
          <Pressable
            onPress={() => void resetToBuildChannel()}
            disabled={isSwitching}
            accessibilityRole="button"
            accessibilityLabel={t('mobile.previewChannels.reset', { channel: buildChannel })}
            accessibilityState={{ disabled: isSwitching }}
            style={[styles.resetButton, { marginHorizontal: spacing[4], opacity: isSwitching ? 0.5 : 1 }]}
          >
            <Icon name="refresh" size={16} color={systemColors.label} />
            <Text variant="footnote" color={systemColors.label}>
              {t('mobile.previewChannels.reset', { channel: buildChannel })}
            </Text>
          </Pressable>
        </>
      ) : null}

      {isTester ? (
        <>
          {/* i18n-ignore-next-line — tester-only screen */}
          <SectionHeader title="Test crash reporting (Sentry)" />
          <View style={cardStyle}>
            {/* i18n-ignore-next-line — tester-only screen */}
            <InfoRow label="Sentry" value={isSentryEnabled ? 'Active' : 'Disabled in this build'} />
            <ListRow
              // i18n-ignore-next-line — tester-only screen
              title="Send test event (handled)"
              trailing={<Icon name="send" size={18} color={systemColors.secondaryLabel} />}
              onPress={sendSentryTestEvent}
              showSeparator
            />
            <ListRow
              // i18n-ignore-next-line — tester-only screen
              title="Throw JS exception (uncaught)"
              trailing={<Icon name="warning" size={18} color={brandColors.warning} />}
              onPress={throwSentryUncaught}
              showSeparator
            />
            <ListRow
              // i18n-ignore-next-line — tester-only screen
              title="Native crash"
              trailing={<Icon name="flame" size={18} color={brandColors.error} />}
              onPress={() => void triggerSentryNativeCrash()}
              showSeparator={false}
            />
          </View>
        </>
      ) : null}

      <View style={styles.bottomSpacer} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: 12,
    overflow: 'hidden',
  },
  notice: {
    paddingVertical: 16,
  },
  intro: {
    marginBottom: 8,
    lineHeight: 18,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
  },
  statusText: {
    paddingVertical: 8,
  },
  customRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  input: {
    flex: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  goButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  resetButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    marginTop: 16,
  },
  disabledRow: {
    opacity: 0.5,
  },
  bottomSpacer: {
    height: 40,
  },
});
