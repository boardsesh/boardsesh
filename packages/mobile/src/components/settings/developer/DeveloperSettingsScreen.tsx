import { useMemo } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { Redirect } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { scopedRouter as router } from '../../../lib/routing/scoped-navigation';
import { MoreForm } from '../../MoreForm';
import { getDevMetadataSection } from '../../dev-metadata-section';
import { useConnectivity } from '../../../lib/connectivity/use-connectivity';
import { setDevForcedUnreachable } from '../../../lib/connectivity/connectivity-store';
import { isDevLauncherAvailable } from '../../../lib/dev-launcher';
import { hapticLight, hapticSelection } from '../../../lib/haptics';
import { withSettingTracking } from '../../../lib/settings-analytics';
import { useTheme } from '../../../providers/theme-provider';
import { useSetting } from '../../../settings';
import { spacing } from '../../../theme/tokens';
import { buildDeveloperModel } from './developer-model';
import { useDeveloperSettingsAccess } from './use-developer-settings-access';

export function DeveloperSettingsScreen() {
  const { t } = useTranslation('common');
  const { systemColors } = useTheme();
  const access = useDeveloperSettingsAccess();
  const { devForcedUnreachable } = useConnectivity();
  const [bottomChromeDiagnostics, setBottomChromeDiagnostics] = useSetting('bottomChromeDiagnostics');
  const devMetadataSection = useMemo(() => getDevMetadataSection(), []);
  const {
    showDevTools,
    showPreviewBuild,
    showBottomChromeDiagnostics: bottomChromeDiagnosticsEligible,
    isTester,
    isAdmin,
  } = access;

  const model = useMemo(
    () =>
      withSettingTracking(
        buildDeveloperModel({
          t,
          devMetadataSection,
          devTools: showDevTools
            ? {
                // Live Metro switching needs expo-dev-client's native launcher,
                // which is only linked into dev-client / Debug builds, never the
                // store binary (where it would throw "Dev launcher unavailable").
                showDevServerSwitcher: isDevLauncherAvailable(),
                // Flag overrides work in every build (dev forces them in place of
                // the disabled PostHog read; release builds layer them on top).
                showFeatureFlags: __DEV__ || isTester,
                // Hold a real SQLite write lock, inject fault shapes, inspect the
                // outbox. Same audience as the flag overrides.
                showOfflineWrites: __DEV__ || isTester,
                showQaPicker: __DEV__,
                // Rewrites the silhouettes every climber's board renders, so
                // admin-only rather than tester-only. `isAdmin` rides its own
                // small query, which fails closed.
                showOutlineEditor: __DEV__ || isAdmin,
                showSentryDiagnostics: __DEV__ || isTester,
                forceServerUnreachable: {
                  enabled: devForcedUnreachable,
                  onChange: (enabled) => {
                    hapticSelection();
                    setDevForcedUnreachable(enabled);
                  },
                },
              }
            : null,
          // Dev, preview and pr-channel sessions only, so regular production
          // climbers never see the row.
          bottomChromeDiagnostics: bottomChromeDiagnosticsEligible
            ? {
                enabled: bottomChromeDiagnostics,
                onChange: (enabled) => {
                  hapticSelection();
                  setBottomChromeDiagnostics(enabled);
                },
              }
            : null,
          showPreviewBuild,
          onNavigate: (href) => {
            hapticLight();
            router.push(href);
          },
        }),
        'developer',
      ),
    [
      t,
      devMetadataSection,
      showDevTools,
      isTester,
      isAdmin,
      devForcedUnreachable,
      bottomChromeDiagnosticsEligible,
      bottomChromeDiagnostics,
      setBottomChromeDiagnostics,
      showPreviewBuild,
    ],
  );

  // Route guard. Hiding the root row is not a guard: a deep link reaches this
  // route directly, and the switches here act on the whole app. Wait for the
  // profile and admin answers before turning anyone away.
  if (access.loading) {
    return (
      <View style={[styles.loading, { backgroundColor: systemColors.groupedBackground }]}>
        <ActivityIndicator />
      </View>
    );
  }
  if (!access.allowed) {
    return <Redirect href="/settings" />;
  }

  return <MoreForm model={model} />;
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing[10],
  },
});
