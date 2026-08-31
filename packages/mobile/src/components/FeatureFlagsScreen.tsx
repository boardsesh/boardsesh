import { useCallback, useEffect, useMemo, useState } from 'react';
import { View, StyleSheet, ActivityIndicator } from 'react-native';
import { Redirect } from 'expo-router';
import { useTheme } from '../providers/theme-provider';
import { hapticLight, hapticSelection } from '../lib/haptics';
import { spacing } from '../theme/tokens';
import { FEATURE_FLAG_DEFINITIONS } from '../providers/feature-flags-provider';
import { useFeatureFlagOverrides } from '../lib/feature-flag-overrides';
import { readPosthogFeatureFlags, subscribePosthogFeatureFlags } from '../lib/analytics';
import { useProfile } from '../lib/graphql/hooks';
import {
  buildFeatureFlagRows,
  findStaleFeatureFlagOverrideKeys,
  resolveFeatureFlagOverrideAction,
} from './feature-flag-rows';
import { FeatureFlagsForm } from './FeatureFlagsForm';
import type { FeatureFlagRow } from './FeatureFlagsForm.types';

const NO_BASE_FLAGS: Record<string, boolean | string> = {};

// Tester-only screen — all copy is hardcoded English with `i18n-ignore`, matching
// the other development screens. It lets a tester force any catalog flag On/Off (or back
// to Default) on-device; the choice is the highest-precedence layer in the
// FeatureFlagsProvider merge and persists across restarts.
//
// This is the SHARED route component: it owns the route guards + data hooks and
// builds a plain view-model array, then hands rendering to the platform-split
// <FeatureFlagsForm /> (a native SwiftUI Form on iOS, a Compose card list on
// Android). The native tree renders strings only — every derived caption is
// precomputed here.

// i18n-ignore-next-line — tester-only screen
const SCREEN_TITLE = 'Feature Flags';
// i18n-ignore-next-line — tester-only screen
const NOTICE_TEXT =
  'Force a flag On or Off on this device. Overrides win over PostHog and build-time settings and persist across restarts. Default falls back to the live (PostHog) value.';

export function FeatureFlagsScreen() {
  const { systemColors } = useTheme();
  const { overrides, loaded: overridesLoaded, setOverride, clearOverride, clearAll } = useFeatureFlagOverrides();
  const { data: profile, isLoading: profileLoading } = useProfile();

  // Resolved base values (PostHog) so the caption can show what a flag falls back
  // to when its override is cleared. No-op / empty in dev or unkeyed builds.
  //
  // Subscribed, not read once on mount: on a cold open the SDK has usually not
  // stored a /flags payload yet, so a mount-only read makes every row read
  // "Live default: not set" forever — which is indistinguishable from a flag
  // that genuinely never resolves, the one thing a tester opens this screen to
  // check. subscribePosthogFeatureFlags also kicks a reload, same as
  // FeatureFlagsProvider does.
  const [baseFlags, setBaseFlags] = useState<Record<string, boolean | string>>(NO_BASE_FLAGS);
  useEffect(() => {
    let mounted = true;
    const refreshBaseFlags = () => {
      const nextFlags = readPosthogFeatureFlags(FEATURE_FLAG_DEFINITIONS);
      if (!mounted) return;
      setBaseFlags((previousFlags) => (baseFlagsEqual(previousFlags, nextFlags) ? previousFlags : nextFlags));
    };
    refreshBaseFlags();
    const unsubscribe = subscribePosthogFeatureFlags(refreshBaseFlags);
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);
  const hasOverrides = Object.keys(overrides).length > 0;

  // The native form's view model. Memoized so the Host's children don't rebuild
  // every render (the form is a single native tree). Each row carries the
  // precomputed "Live default… Effective…" caption so the native side renders a
  // plain string.
  const rows = useMemo<FeatureFlagRow[]>(
    () => buildFeatureFlagRows(FEATURE_FLAG_DEFINITIONS, overrides, baseFlags),
    [overrides, baseFlags],
  );

  // Drop overrides a flag can no longer honour — a boolean forced on a flag
  // that has since become multivariate. The row already renders at 'Default',
  // which is exactly why the tester can't clear it by hand: re-selecting the
  // segment it's already on fires nothing. See findStaleFeatureFlagOverrideKeys.
  useEffect(() => {
    for (const key of findStaleFeatureFlagOverrideKeys(FEATURE_FLAG_DEFINITIONS, overrides)) {
      clearOverride(key);
    }
  }, [overrides, clearOverride]);

  const handleSelect = useCallback(
    (key: string, choice: string) => {
      // The native segmented controls don't fire a selection haptic on their own,
      // so keep the tactile feedback the old SegmentedControl provided.
      hapticSelection();
      const resolved = resolveFeatureFlagOverrideAction(choice);
      if (resolved.action === 'clear') {
        clearOverride(key);
        return;
      }
      setOverride(key, resolved.value);
    },
    [clearOverride, setOverride],
  );

  const handleReset = useCallback(() => {
    hapticLight();
    clearAll();
  }, [clearAll]);

  // Route guard. Hiding the More-tab row for non-testers is not a guard — a deep
  // link or manual navigation reaches this route directly, and the overrides it
  // writes apply globally via FeatureFlagsProvider, so a non-tester could force
  // rollout-only flags on. Gate the screen itself: __DEV__ always passes (the
  // profile query may not resolve in dev); otherwise wait for the profile, then
  // keep non-testers out.
  if (!__DEV__) {
    if (profileLoading) {
      return (
        <View style={[styles.loading, { backgroundColor: systemColors.groupedBackground }]}>
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
      <View style={[styles.loading, { backgroundColor: systemColors.groupedBackground }]}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <FeatureFlagsForm
      rows={rows}
      onSelect={handleSelect}
      onReset={handleReset}
      canReset={hasOverrides}
      noticeText={NOTICE_TEXT}
      title={SCREEN_TITLE}
    />
  );
}

function baseFlagsEqual(
  leftFlags: Record<string, boolean | string>,
  rightFlags: Record<string, boolean | string>,
): boolean {
  const leftKeys = Object.keys(leftFlags);
  const rightKeys = Object.keys(rightFlags);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => leftFlags[key] === rightFlags[key]);
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing[10],
  },
});
