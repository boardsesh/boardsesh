import { useState, useCallback, useEffect, useRef } from 'react';
import { View, ScrollView, ActivityIndicator, Alert, Pressable, StyleSheet, TextInput } from 'react-native';
import * as Updates from 'expo-updates';
import { reportHandledError } from '../lib/error-reporting';
import { Text } from './Text';
import { SectionHeader } from './SectionHeader';
import { ListRow } from './ListRow';
import { Icon } from './Icon';
import { InfoRow } from './InfoRow';
import { useTheme } from '../providers/theme-provider';
import { useConfirm } from '../providers/dialog-provider';
import { hapticLight, hapticError } from '../lib/haptics';
import { getPreference, setPreference, removePreference } from '../lib/preference-store';
import {
  OTA_CHANNEL_OVERRIDE_KEY,
  buildChannelList,
  performChannelSwitch,
  performChannelReset,
  type ChannelSwitchDeps,
} from '../lib/channel-switch';

// Switch channels by overriding ONLY the `expo-channel-name` request header,
// keeping the build's update URL (so the embedded code-signing cert still
// verifies the manifest). Unlike setUpdateURLAndRequestHeadersOverride, the
// header-only override needs NO `disableAntiBrickingMeasures` — expo-updates
// permits overriding a header that was baked in at build time, and production
// builds bake `expo-channel-name`. It throws if that header wasn't embedded
// (e.g. EAS-hosted builds); callers catch and surface that. `null` clears the
// override and reverts to the build-time channel.
function applyChannelOverride(channel: string | null): void {
  Updates.setUpdateRequestHeadersOverride(channel === null ? null : { 'expo-channel-name': channel });
}

export function ChannelSwitcherScreen() {
  const { systemColors, spacing, borderRadius } = useTheme();
  const confirm = useConfirm();
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

  const buildChannel = Updates.channel ?? 'unknown';
  const runtimeVersion = Updates.runtimeVersion ?? 'unknown';
  const updatesUsable = Updates.isEnabled && !__DEV__;
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

  const switchToChannel = useCallback(
    async (channel: string) => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      const previousOverride = overrideRef.current;
      try {
        hapticLight();
        const confirmed = await confirm({
          // i18n-ignore-next-line — tester-only screen
          title: 'Switch OTA channel',
          // i18n-ignore-next-line — tester-only screen
          message: `Pull the latest update from "${channel}" and restart? It must have an update published for this build's fingerprint.`,
          // i18n-ignore-next-line — tester-only screen
          confirmLabel: 'Switch',
          // i18n-ignore-next-line — tester-only screen
          cancelLabel: 'Cancel',
        });
        if (!confirmed) return;

        setSwitchingChannel(channel);
        const result = await performChannelSwitch(channel, previousOverride, runtimeVersion, makeDeps());
        if (result.status === 'reverted') {
          hapticError();
          Alert.alert(
            // i18n-ignore-next-line — tester-only screen
            'Switch failed',
            result.error instanceof Error
              ? result.error.message
              : 'Could not switch channel. This build may not support channel overrides.',
          );
        } else {
          // 'switched' (the app reloads) or 'pending-restart' — reflect the new channel.
          setOverride(channel);
          if (result.status === 'pending-restart') {
            // i18n-ignore-next-line — tester-only screen
            Alert.alert('Restart to finish', `Downloaded "${channel}". Restart the app to switch onto it.`);
          }
        }
      } finally {
        setSwitchingChannel(null);
        inFlightRef.current = false;
      }
    },
    [confirm, runtimeVersion, makeDeps],
  );

  const resetToBuildChannel = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    const previousOverride = overrideRef.current;
    try {
      hapticLight();
      const confirmed = await confirm({
        // i18n-ignore-next-line — tester-only screen
        title: 'Reset to build channel',
        // i18n-ignore-next-line — tester-only screen
        message: `Clear the override and return to "${buildChannel}"? The app will restart.`,
        // i18n-ignore-next-line — tester-only screen
        confirmLabel: 'Reset',
        // i18n-ignore-next-line — tester-only screen
        cancelLabel: 'Cancel',
      });
      if (!confirmed) return;

      setSwitchingChannel(buildChannel);
      const result = await performChannelReset(previousOverride, makeDeps());
      if (result.status === 'failed') {
        hapticError();
        // The override was re-applied on the failed reset, so the build is still on the
        // previous channel (or the build channel if there was no override). Say so.
        const stayedOn = previousOverride ?? buildChannel;
        const reason = result.error instanceof Error ? result.error.message : 'Could not reset channel.';
        // i18n-ignore-next-line — tester-only screen
        Alert.alert('Reset failed', `${reason} Stayed on "${stayedOn}".`);
      } else {
        setOverride(null);
        if (result.status === 'pending-restart') {
          // i18n-ignore-next-line — tester-only screen
          Alert.alert('Restart to finish', `Cleared the override. Restart the app to return to "${buildChannel}".`);
        }
      }
    } finally {
      setSwitchingChannel(null);
      inFlightRef.current = false;
    }
  }, [confirm, buildChannel, makeDeps]);

  const channels = buildChannelList(override);

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic">
      {/* i18n-ignore-next-line — tester-only screen */}
      <SectionHeader title="Current Update" />
      <View
        style={[
          styles.card,
          {
            backgroundColor: systemColors.secondaryBackground,
            borderRadius: borderRadius.lg,
            marginHorizontal: spacing[4],
          },
        ]}
      >
        {/* i18n-ignore-next-line — tester-only screen */}
        <InfoRow label="Build channel" value={buildChannel} />
        {/* i18n-ignore-next-line — tester-only screen */}
        <InfoRow label="Selected channel" value={override ?? `${buildChannel} (default)`} />
        {/* i18n-ignore-next-line — tester-only screen */}
        <InfoRow label="Runtime version" value={runtimeVersion} showSeparator={false} />
      </View>

      {!updatesUsable ? (
        <View style={[styles.notice, { marginHorizontal: spacing[4] }]}>
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            {/* i18n-ignore-next-line — tester-only screen */}
            OTA updates are disabled in this build (development or updates not enabled), so channel switching is
            unavailable here. Use a TestFlight/store build.
          </Text>
        </View>
      ) : (
        <>
          {/* i18n-ignore-next-line — tester-only screen */}
          <SectionHeader title="Switch Channel" />
          <View
            style={[
              styles.card,
              {
                backgroundColor: systemColors.secondaryBackground,
                borderRadius: borderRadius.lg,
                marginHorizontal: spacing[4],
              },
            ]}
          >
            {channels.map((channel, index) => {
              const isActive = channel === activeChannel;
              const isThisSwitching = switchingChannel === channel;
              const isDisabled = isSwitching && !isThisSwitching;
              const trailing = isThisSwitching ? (
                <ActivityIndicator size="small" />
              ) : isActive ? (
                <Icon name="check.small" size={20} color={systemColors.label} />
              ) : null;

              return (
                <ListRow
                  key={channel}
                  title={channel}
                  trailing={trailing}
                  onPress={isActive || isDisabled ? undefined : () => void switchToChannel(channel)}
                  showSeparator={index < channels.length - 1}
                  style={isDisabled ? styles.disabledRow : undefined}
                />
              );
            })}
          </View>

          {/* i18n-ignore-next-line — tester-only screen */}
          <SectionHeader title="Custom Channel" />
          <View style={[styles.customRow, { marginHorizontal: spacing[4] }]}>
            <TextInput
              value={customChannel}
              onChangeText={setCustomChannel}
              // i18n-ignore-next-line — tester-only screen
              placeholder="channel name"
              placeholderTextColor={systemColors.secondaryLabel}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!isSwitching}
              // i18n-ignore-next-line — tester-only screen
              accessibilityLabel="Custom OTA channel name"
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
              // i18n-ignore-next-line — tester-only screen
              accessibilityLabel="Switch to the entered channel"
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
                {/* i18n-ignore-next-line — tester-only screen */}
                Switch
              </Text>
            </Pressable>
          </View>

          {/* Always offered (not gated on `override`) so a native override stranded
              after an app-data clear — when the display mirror is gone — stays
              clearable. */}
          <Pressable
            onPress={() => void resetToBuildChannel()}
            disabled={isSwitching}
            accessibilityRole="button"
            // i18n-ignore-next-line — tester-only screen
            accessibilityLabel="Reset to build channel"
            accessibilityState={{ disabled: isSwitching }}
            style={[styles.resetButton, { marginHorizontal: spacing[4], opacity: isSwitching ? 0.5 : 1 }]}
          >
            <Icon name="refresh" size={16} color={systemColors.label} />
            <Text variant="footnote" color={systemColors.label}>
              {/* i18n-ignore-next-line — tester-only screen */}
              Reset to build channel ({buildChannel})
            </Text>
          </Pressable>
        </>
      )}

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
