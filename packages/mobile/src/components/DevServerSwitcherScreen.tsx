import { useState, useCallback, useMemo, useRef } from 'react';
import {
  View,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Modal,
  TextInput,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import BottomSheet, { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import Constants from 'expo-constants';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Text } from './Text';
import { SectionHeader } from './SectionHeader';
import { ListRow } from './ListRow';
import { Icon } from './Icon';
import { InfoRow } from './InfoRow';
import { Button } from './Button';
import { Sheet } from './Sheet';
import { useTheme } from '../providers/theme-provider';
import { hapticLight, hapticError } from '../lib/haptics';
import { discoverBundlers, type DiscoveredBundler } from '../lib/metro-discovery';
import { addSavedMetroTarget, getSavedMetroTargets, removeSavedMetroTarget } from '../lib/metro-target-store';

type ExpoDevLauncherModule = {
  loadApp(url: string): Promise<boolean>;
};

const ExpoDevLauncher = requireOptionalNativeModule<ExpoDevLauncherModule>('ExpoDevLauncher');

function getDevBundlerHosts(): string[] {
  const hosts = Constants.expoConfig?.extra?.devBundlerHosts;
  if (!Array.isArray(hosts)) return [];
  return hosts.filter((host): host is string => typeof host === 'string' && host.length > 0);
}

function formatBundlerTitle(bundler: DiscoveredBundler): string {
  return bundler.metadata?.branchName ?? bundler.metadata?.label ?? `${bundler.host}:${bundler.port}`;
}

function formatBundlerSubtitle(bundler: DiscoveredBundler): string {
  const label = bundler.metadata?.label;
  const address = `${bundler.host}:${bundler.port}`;
  return label && label !== bundler.metadata?.branchName ? `${label} · ${address}` : address;
}

function formatStartedAt(value: string | null | undefined): string {
  if (!value) return 'unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export function DevServerSwitcherScreen() {
  const { systemColors, spacing, borderRadius } = useTheme();
  const queryClient = useQueryClient();
  const infoSheetRef = useRef<BottomSheet>(null);
  const [switchingUrl, setSwitchingUrl] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [selectedBundler, setSelectedBundler] = useState<DiscoveredBundler | null>(null);
  const [isAddPromptOpen, setIsAddPromptOpen] = useState(false);
  const [addInputValue, setAddInputValue] = useState('');

  const bundlerHosts = useMemo(getDevBundlerHosts, []);
  const savedTargetsQuery = useQuery({
    queryKey: ['saved-metro-targets'],
    queryFn: getSavedMetroTargets,
    staleTime: 30_000,
  });
  const savedTargets = savedTargetsQuery.data ?? [];

  const bundlersQuery = useQuery({
    queryKey: ['dev-bundlers', bundlerHosts, savedTargets],
    // React Query passes its own AbortSignal — propagate so invalidations
    // (pull-to-refresh, savedTargets change) cancel in-flight port probes
    // instead of leaving them running to completion.
    queryFn: ({ signal }) => discoverBundlers({ hosts: bundlerHosts, savedTargets, signal }),
    staleTime: 30_000,
    enabled: savedTargetsQuery.isSuccess,
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
      hapticError();
      // i18n-ignore-next-line
      Alert.alert('Switch Failed', mutationError instanceof Error ? mutationError.message : 'Unknown error');
    },
    // onSettled fires on both success and failure — covers the silent-success
    // edge case where loadApp resolves without unmounting (same bundle, bridge
    // hot-reload) and leaves the spinner stuck otherwise.
    onSettled: () => {
      setSwitchingUrl(null);
    },
  });

  const addTargetMutation = useMutation({
    mutationFn: addSavedMetroTarget,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['saved-metro-targets'] });
      await queryClient.invalidateQueries({ queryKey: ['dev-bundlers'] });
    },
    onError: (mutationError: unknown) => {
      hapticError();
      // i18n-ignore-next-line
      Alert.alert('Save Failed', mutationError instanceof Error ? mutationError.message : 'Unknown error');
    },
  });

  const removeTargetMutation = useMutation({
    mutationFn: removeSavedMetroTarget,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['saved-metro-targets'] });
      await queryClient.invalidateQueries({ queryKey: ['dev-bundlers'] });
    },
    onError: (mutationError: unknown) => {
      hapticError();
      // i18n-ignore-next-line
      Alert.alert('Remove Failed', mutationError instanceof Error ? mutationError.message : 'Unknown error');
    },
  });

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['saved-metro-targets'] }),
        queryClient.invalidateQueries({ queryKey: ['dev-bundlers'] }),
      ]);
    } finally {
      // try/finally so a query rejection (or unmount mid-refresh) doesn't
      // strand the pull-to-refresh spinner.
      setIsRefreshing(false);
    }
  }, [queryClient]);

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

  const handleShowInfo = useCallback((bundler: DiscoveredBundler) => {
    hapticLight();
    setSelectedBundler(bundler);
    infoSheetRef.current?.snapToIndex(0);
  }, []);

  const handleAddTarget = useCallback(() => {
    hapticLight();
    // Alert.prompt is iOS-only — a controlled Modal + TextInput works on both
    // platforms. Inputs are dev-only and only seen by developers.
    setAddInputValue('');
    setIsAddPromptOpen(true);
  }, []);

  const handleAddPromptSave = useCallback(() => {
    const value = addInputValue.trim();
    setIsAddPromptOpen(false);
    if (value.length === 0) return;
    addTargetMutation.mutate(value);
  }, [addInputValue, addTargetMutation]);

  const handleAddPromptCancel = useCallback(() => {
    setIsAddPromptOpen(false);
  }, []);

  const handleRemoveTarget = useCallback(
    (target: string) => {
      hapticLight();
      // i18n-ignore-next-line
      Alert.alert('Remove Metro Server', target, [
        // i18n-ignore-next-line
        { text: 'Cancel', style: 'cancel' },
        {
          // i18n-ignore-next-line
          text: 'Remove',
          style: 'destructive',
          onPress: () => removeTargetMutation.mutate(target),
        },
      ]);
    },
    [removeTargetMutation],
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
    <>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={handleRefresh} />}
      >
        {/* ---- Dev bundlers status ---- */}
        {/* i18n-ignore-next-line */}
        <SectionHeader title="Dev bundlers" />
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
          <InfoRow label="Hosts probed" value={String(bundlerHosts.length)} />
          {/* i18n-ignore-next-line */}
          <InfoRow label="Saved targets" value={String(savedTargets.length)} />
          {/* i18n-ignore-next-line */}
          <InfoRow label="Dev launcher" value={ExpoDevLauncher ? 'available' : 'missing'} />
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

        <View style={[styles.actionBar, { marginHorizontal: spacing[4] }]}>
          <Button
            // i18n-ignore-next-line
            title="Add Server"
            icon="add"
            variant="outlined"
            size="small"
            onPress={handleAddTarget}
            loading={addTargetMutation.isPending}
          />
          <Button
            // i18n-ignore-next-line
            title="Refresh"
            icon="refresh"
            variant="text"
            size="small"
            onPress={() => {
              void handleRefresh();
            }}
          />
        </View>

        {savedTargetsQuery.isLoading ? (
          <View style={styles.centered}>
            <ActivityIndicator />
          </View>
        ) : bundlerHosts.length === 0 && savedTargets.length === 0 ? (
          <View style={[styles.errorContainer, { marginHorizontal: spacing[4] }]}>
            {/* i18n-ignore-next-line */}
            <Text variant="footnote" color={systemColors.secondaryLabel}>
              No hosts embedded or saved. Add a Tailnet/LAN host or an http://host:port URL.
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
              No Metro bundlers responded on ports 8081–8099. Start one with `vp run dev:mobile`.
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
                  const trailing = (
                    <View style={styles.rowActions}>
                      <Pressable
                        accessibilityRole="button"
                        // i18n-ignore-next-line
                        accessibilityLabel="Server info"
                        onPress={(event) => {
                          event.stopPropagation();
                          handleShowInfo(bundler);
                        }}
                        style={styles.iconButton}
                      >
                        <Icon name="info" size={20} color={systemColors.secondaryLabel} />
                      </Pressable>
                      {isThisSwitching ? <ActivityIndicator size="small" /> : null}
                    </View>
                  );

                  return (
                    <ListRow
                      key={bundler.url}
                      title={formatBundlerTitle(bundler)}
                      subtitle={formatBundlerSubtitle(bundler)}
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

        {savedTargets.length > 0 ? (
          <>
            {/* i18n-ignore-next-line */}
            <SectionHeader title="Saved Servers" />
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
              {savedTargets.map((target, index) => (
                <ListRow
                  key={target}
                  title={target}
                  trailing={
                    <Pressable
                      accessibilityRole="button"
                      // i18n-ignore-next-line
                      accessibilityLabel="Remove saved server"
                      onPress={() => handleRemoveTarget(target)}
                      style={styles.iconButton}
                    >
                      <Icon name="delete" size={20} color={systemColors.secondaryLabel} />
                    </Pressable>
                  }
                  haptic={false}
                  showSeparator={index < savedTargets.length - 1}
                />
              ))}
            </View>
          </>
        ) : null}

        <View style={styles.bottomSpacer} />
      </ScrollView>

      <Sheet ref={infoSheetRef} snapPoints={['55%', '90%']}>
        {selectedBundler ? (
          <BottomSheetScrollView contentContainerStyle={styles.sheetContent}>
            {/* i18n-ignore-next-line */}
            <SectionHeader title="Metro Server" />
            <View
              style={[
                styles.card,
                {
                  backgroundColor: systemColors.secondaryBackground,
                  borderRadius: borderRadius.lg,
                },
              ]}
            >
              {/* i18n-ignore-next-line */}
              <InfoRow label="URL" value={selectedBundler.url} />
              {/* i18n-ignore-next-line */}
              <InfoRow label="Branch" value={selectedBundler.metadata?.branchName ?? 'unknown'} />
              {/* i18n-ignore-next-line */}
              <InfoRow label="Worktree" value={selectedBundler.metadata?.label ?? 'unknown'} />
              {/* i18n-ignore-next-line */}
              <InfoRow label="Commit" value={selectedBundler.metadata?.commitSha ?? 'unknown'} />
              {/* i18n-ignore-next-line */}
              <InfoRow label="Started" value={formatStartedAt(selectedBundler.metadata?.startedAt)} />
              {/* i18n-ignore-next-line */}
              <InfoRow label="Metadata" value={selectedBundler.metadataStatus} showSeparator={false} />
            </View>

            {/* i18n-ignore-next-line */}
            <SectionHeader title="QA Plan" />
            <View
              style={[
                styles.qaCard,
                {
                  backgroundColor: systemColors.secondaryBackground,
                  borderRadius: borderRadius.lg,
                },
              ]}
            >
              <Text variant="caption1" color={systemColors.label} style={styles.qaText} selectable>
                {selectedBundler.metadata?.qaNotes ?? 'No QA plan loaded for this Metro server.'}
              </Text>
              {selectedBundler.metadata?.qaNotesFilePath ? (
                <Text variant="caption2" color={systemColors.tertiaryLabel} style={styles.filePath} selectable>
                  {selectedBundler.metadata.qaNotesFilePath}
                </Text>
              ) : null}
            </View>

            <Button
              // i18n-ignore-next-line
              title="Switch to Server"
              icon="chevron.right"
              onPress={() => {
                infoSheetRef.current?.close();
                handleSwitchBundler(selectedBundler);
              }}
              loading={switchingUrl === selectedBundler.url}
              disabled={isSwitching && switchingUrl !== selectedBundler.url}
              style={styles.sheetButton}
            />
          </BottomSheetScrollView>
        ) : null}
      </Sheet>

      <Modal animationType="fade" transparent visible={isAddPromptOpen} onRequestClose={handleAddPromptCancel}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.modalOverlay}>
          <View
            style={[
              styles.modalCard,
              { backgroundColor: systemColors.secondaryBackground, borderRadius: borderRadius.lg },
            ]}
          >
            {/* i18n-ignore-next-line */}
            <Text variant="headline" color={systemColors.label}>
              Add Metro Server
            </Text>
            {/* i18n-ignore-next-line */}
            <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.modalSubtitle}>
              Enter a Tailnet/LAN host or an http://host:port URL.
            </Text>
            <TextInput
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              value={addInputValue}
              onChangeText={setAddInputValue}
              onSubmitEditing={handleAddPromptSave}
              // i18n-ignore-next-line
              placeholder="host or http://host:port"
              placeholderTextColor={systemColors.tertiaryLabel}
              style={[
                styles.modalInput,
                {
                  color: systemColors.label,
                  backgroundColor: systemColors.tertiaryBackground,
                  borderRadius: borderRadius.md,
                },
              ]}
            />
            <View style={styles.modalActions}>
              <Button
                // i18n-ignore-next-line
                title="Cancel"
                variant="text"
                size="small"
                onPress={handleAddPromptCancel}
              />
              <Button
                // i18n-ignore-next-line
                title="Save"
                variant="filled"
                size="small"
                onPress={handleAddPromptSave}
                disabled={addInputValue.trim().length === 0}
              />
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </>
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
  actionBar: {
    flexDirection: 'row',
    gap: 8,
    paddingBottom: 8,
  },
  rowActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  iconButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
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
  sheetContent: {
    paddingBottom: 32,
  },
  qaCard: {
    marginHorizontal: 16,
    padding: 12,
  },
  qaText: {
    lineHeight: 18,
  },
  filePath: {
    marginTop: 8,
  },
  sheetButton: {
    marginHorizontal: 16,
    marginTop: 16,
  },
  bottomSpacer: {
    height: 40,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  modalCard: {
    padding: 20,
    gap: 12,
  },
  modalSubtitle: {
    marginBottom: 4,
  },
  modalInput: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
    marginTop: 4,
  },
});
