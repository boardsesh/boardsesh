import { useState, useCallback, useMemo } from 'react';
import { View, ScrollView, RefreshControl, ActivityIndicator, Alert, Pressable, StyleSheet } from 'react-native';
import Constants from 'expo-constants';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Text } from './Text';
import { SectionHeader } from './SectionHeader';
import { ListRow } from './ListRow';
import { Icon } from './Icon';
import { InfoRow } from './InfoRow';
import { useTheme } from '../providers/theme-provider';
import { hapticLight, hapticError } from '../lib/haptics';
import { discoverBundlers, type DiscoveredBundler } from '../lib/metro-discovery';

type ExpoDevLauncherModule = {
  loadApp(url: string): Promise<boolean>;
};

const ExpoDevLauncher = requireOptionalNativeModule<ExpoDevLauncherModule>('ExpoDevLauncher');

function getTailscaleHosts(): string[] {
  const hosts = Constants.expoConfig?.extra?.tailscaleHosts;
  if (!Array.isArray(hosts)) return [];
  return hosts.filter((host): host is string => typeof host === 'string' && host.length > 0);
}

export function DevServerSwitcherScreen() {
  const { systemColors, spacing, borderRadius } = useTheme();
  const queryClient = useQueryClient();
  const [switchingUrl, setSwitchingUrl] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const tailscaleHosts = useMemo(getTailscaleHosts, []);

  const bundlersQuery = useQuery({
    queryKey: ['dev-bundlers', tailscaleHosts],
    queryFn: () => discoverBundlers(tailscaleHosts),
    staleTime: 30_000,
    enabled: tailscaleHosts.length > 0,
  });

  const switchMutation = useMutation({
    mutationFn: async (bundler: DiscoveredBundler) => {
      if (!ExpoDevLauncher) {
        throw new Error('Dev launcher unavailable — install expo-dev-client and rebuild');
      }
      setSwitchingUrl(bundler.url);
      await ExpoDevLauncher.loadApp(bundler.url);
    },
    onError: (mutationError: unknown) => {
      setSwitchingUrl(null);
      hapticError();
      // i18n-ignore-next-line
      Alert.alert('Switch Failed', mutationError instanceof Error ? mutationError.message : 'Unknown error');
    },
  });

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await queryClient.invalidateQueries({ queryKey: ['dev-bundlers', tailscaleHosts] });
    setIsRefreshing(false);
  }, [queryClient, tailscaleHosts]);

  const handleSwitchBundler = useCallback(
    (bundler: DiscoveredBundler) => {
      hapticLight();
      // i18n-ignore-next-line
      Alert.alert('Switch Metro Server', `Load JS bundle from ${bundler.host}:${bundler.port}? The app will reload.`, [
        // i18n-ignore-next-line
        { text: 'Cancel', style: 'cancel' },
        // i18n-ignore-next-line
        { text: 'Switch', onPress: () => switchMutation.mutate(bundler) },
      ]);
    },
    [switchMutation],
  );

  const isSwitching = switchingUrl !== null;
  const bundlers = bundlersQuery.data ?? [];
  const bundlersByHost = useMemo(() => {
    const grouped = new Map<string, DiscoveredBundler[]>();
    for (const bundler of bundlers) {
      const existing = grouped.get(bundler.host) ?? [];
      existing.push(bundler);
      grouped.set(bundler.host, existing);
    }
    return Array.from(grouped.entries());
  }, [bundlers]);

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={handleRefresh} />}
    >
      {/* ---- Tailnet status ---- */}
      {/* i18n-ignore-next-line */}
      <SectionHeader title="Tailnet" />
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
        {/* i18n-ignore-next-line */}
        <InfoRow label="Hosts embedded" value={String(tailscaleHosts.length)} />
        <InfoRow
          // i18n-ignore-next-line
          label="Bundlers live"
          value={bundlersQuery.isLoading ? '…' : String(bundlers.length)}
          showSeparator={false}
        />
      </View>

      {/* ---- Available Bundlers ---- */}
      {/* i18n-ignore-next-line */}
      <SectionHeader title="Available Bundlers" />

      {tailscaleHosts.length === 0 ? (
        <View style={[styles.errorContainer, { marginHorizontal: spacing[4] }]}>
          {/* i18n-ignore-next-line */}
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            No tailnet hosts embedded. Run `tailscale status` on the build machine and rebuild.
          </Text>
        </View>
      ) : bundlersQuery.isLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator />
        </View>
      ) : bundlersQuery.isError ? (
        <View style={[styles.errorContainer, { marginHorizontal: spacing[4] }]}>
          {/* i18n-ignore-next-line */}
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            {bundlersQuery.error instanceof Error ? bundlersQuery.error.message : 'Failed to probe bundlers'}
          </Text>
          <Pressable
            onPress={() => {
              hapticLight();
              void bundlersQuery.refetch();
            }}
            style={[
              styles.retryButton,
              {
                backgroundColor: systemColors.tertiaryBackground,
                borderRadius: borderRadius.md,
              },
            ]}
          >
            <Icon name="refresh" size={16} color={systemColors.label} />
            {/* i18n-ignore-next-line */}
            <Text variant="footnote" color={systemColors.label}>
              Retry
            </Text>
          </Pressable>
        </View>
      ) : bundlers.length === 0 ? (
        <View style={[styles.errorContainer, { marginHorizontal: spacing[4] }]}>
          {/* i18n-ignore-next-line */}
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            No Metro bundlers responded on ports 8081–8089. Start one with `vp run dev:mobile`.
          </Text>
        </View>
      ) : (
        bundlersByHost.map(([host, hostBundlers]) => (
          <View key={host}>
            <SectionHeader title={host} />
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
              {hostBundlers.map((bundler, index) => {
                const isThisSwitching = switchingUrl === bundler.url;
                const isDisabled = isSwitching && !isThisSwitching;
                const trailing = isThisSwitching ? <ActivityIndicator size="small" /> : null;

                return (
                  <ListRow
                    key={bundler.url}
                    title={`Port ${bundler.port}`}
                    subtitle={bundler.url}
                    trailing={trailing}
                    onPress={isDisabled ? undefined : () => handleSwitchBundler(bundler)}
                    haptic={false}
                    showSeparator={index < hostBundlers.length - 1}
                    style={isDisabled ? styles.disabledRow : undefined}
                  />
                );
              })}
            </View>
          </View>
        ))
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
  centered: {
    paddingVertical: 32,
    alignItems: 'center',
  },
  errorContainer: {
    alignItems: 'center',
    paddingVertical: 16,
    gap: 12,
  },
  retryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  disabledRow: {
    opacity: 0.5,
  },
  bottomSpacer: {
    height: 40,
  },
});
