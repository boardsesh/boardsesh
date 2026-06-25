import { useMemo } from 'react';
import { ScrollView, View, StyleSheet, Pressable, ActivityIndicator } from 'react-native';
import { Redirect } from 'expo-router';
import { Text } from './Text';
import { SectionHeader } from './SectionHeader';
import { Icon } from './Icon';
import { useTheme } from '../providers/theme-provider';
import { SegmentedControl } from './SegmentedControl';
import { hapticLight } from '../lib/haptics';
import { spacing } from '../theme/tokens';
import { FEATURE_FLAG_DEFINITIONS, FEATURE_FLAG_KEYS } from '../providers/feature-flags-provider';
import { useFeatureFlagOverrides } from '../lib/feature-flag-overrides';
import { readPosthogFeatureFlags } from '../lib/analytics';
import { useProfile } from '../lib/graphql/hooks';

// Tester-only screen — all copy is hardcoded English with `i18n-ignore`, matching
// ChannelSwitcherScreen. It lets a tester force any catalog flag On/Off (or back
// to Default) on-device; the choice is the highest-precedence layer in the
// FeatureFlagsProvider merge and persists across restarts.

type OverrideChoice = 'default' | 'on' | 'off';

const CHOICE_OPTIONS: { key: OverrideChoice; label: string }[] = [
  // i18n-ignore-next-line — tester-only screen
  { key: 'default', label: 'Default' },
  // i18n-ignore-next-line — tester-only screen
  { key: 'on', label: 'On' },
  // i18n-ignore-next-line — tester-only screen
  { key: 'off', label: 'Off' },
];

export function FeatureFlagsScreen() {
  const { systemColors, borderRadius } = useTheme();
  const { overrides, loaded: overridesLoaded, setOverride, clearOverride, clearAll } = useFeatureFlagOverrides();
  const { data: profile, isLoading: profileLoading } = useProfile();

  // Resolved base values (PostHog) so the footnote can show what a flag falls
  // back to when its override is cleared. No-op / empty in dev or unkeyed builds.
  // Read once on mount: PostHog values rarely move while this tester screen is
  // open, and live override changes already re-render via the store hook.
  const baseFlags = useMemo(() => readPosthogFeatureFlags(FEATURE_FLAG_KEYS), []);
  const hasOverrides = Object.keys(overrides).length > 0;

  const handleSelect = (key: string, choice: OverrideChoice) => {
    if (choice === 'default') {
      clearOverride(key);
    } else {
      setOverride(key, choice === 'on');
    }
  };

  // Route guard. Hiding the More-tab row for non-testers is not a guard — a deep
  // link or manual navigation reaches this route directly, and the overrides it
  // writes apply globally via FeatureFlagsProvider, so a non-tester could force
  // rollout-only flags on. Gate the screen itself: __DEV__ always passes (the
  // profile query may not resolve in dev); otherwise wait for the profile, then
  // keep non-testers out.
  if (!__DEV__) {
    if (profileLoading) {
      return (
        <View style={styles.loading}>
          <ActivityIndicator />
        </View>
      );
    }
    if (!profile?.isTester) {
      return <Redirect href="/(tabs)/profile/more" />;
    }
  }

  // Persisted overrides load async from storage. Wait for them before rendering
  // the controls so a cold open doesn't flash every flag at "Default" and then
  // snap to the tester's saved choices.
  if (!overridesLoaded) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic">
      {/* i18n-ignore-next-line — tester-only screen */}
      <SectionHeader title="Feature Flags" />
      <View style={[styles.notice, { marginHorizontal: spacing[4] }]}>
        <Text variant="footnote" color={systemColors.secondaryLabel}>
          {/* i18n-ignore-next-line — tester-only screen */}
          Force a flag On or Off on this device. Overrides win over PostHog and build-time settings and persist across
          restarts. Default falls back to the live (PostHog) value.
        </Text>
      </View>

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
        {FEATURE_FLAG_DEFINITIONS.map((definition, index) => {
          const override = overrides[definition.key];
          const choice: OverrideChoice = override === undefined ? 'default' : override ? 'on' : 'off';
          const base = baseFlags[definition.key];
          // i18n-ignore-next-line — tester-only screen
          const baseLabel = base === undefined ? 'not set' : base ? 'on' : 'off';
          const effective = override ?? base ?? false;

          return (
            <View
              key={definition.key}
              style={[
                styles.flagRow,
                { paddingVertical: spacing[3], paddingHorizontal: spacing[4] },
                index < FEATURE_FLAG_DEFINITIONS.length - 1 && {
                  borderBottomWidth: StyleSheet.hairlineWidth,
                  borderBottomColor: systemColors.separator,
                },
              ]}
            >
              <Text variant="body">{definition.label}</Text>
              <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.flagDescription}>
                {definition.description}
              </Text>
              <View style={{ marginTop: spacing[2] }}>
                <SegmentedControl
                  options={CHOICE_OPTIONS}
                  selectedKey={choice}
                  onSelect={(next) => handleSelect(definition.key, next)}
                  trackColor={systemColors.fill}
                  textVariant="footnote"
                  accessibilityLabel={definition.label}
                />
              </View>
              <Text variant="caption1" color={systemColors.secondaryLabel} style={{ marginTop: spacing[2] }}>
                {/* i18n-ignore-next-line — tester-only screen */}
                {`Live default: ${baseLabel} · Effective: ${effective ? 'on' : 'off'}`}
              </Text>
            </View>
          );
        })}
      </View>

      <Pressable
        onPress={() => {
          hapticLight();
          clearAll();
        }}
        disabled={!hasOverrides}
        accessibilityRole="button"
        // i18n-ignore-next-line — tester-only screen
        accessibilityLabel="Reset all overrides"
        accessibilityState={{ disabled: !hasOverrides }}
        style={[styles.resetButton, { marginHorizontal: spacing[4], opacity: hasOverrides ? 1 : 0.5 }]}
      >
        <Icon name="refresh" size={16} color={systemColors.label} />
        <Text variant="footnote" color={systemColors.label}>
          {/* i18n-ignore-next-line — tester-only screen */}
          Reset all overrides
        </Text>
      </Pressable>

      <View style={styles.bottomSpacer} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  card: {
    overflow: 'hidden',
  },
  notice: {
    paddingVertical: spacing[4],
  },
  flagRow: {
    width: '100%',
  },
  flagDescription: {
    marginTop: 2,
  },
  resetButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[2],
    paddingVertical: spacing[3],
    marginTop: spacing[4],
  },
  bottomSpacer: {
    height: spacing[10],
  },
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing[10],
  },
});
