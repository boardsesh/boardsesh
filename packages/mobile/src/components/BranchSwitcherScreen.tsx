import { useState, useCallback } from 'react';
import {
  View,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  StyleSheet,
} from 'react-native';
import * as Updates from 'expo-updates';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Text } from './Text';
import { SectionHeader } from './SectionHeader';
import { ListRow } from './ListRow';
import { Icon } from './Icon';
import { InfoRow } from './InfoRow';
import { useTheme } from '../providers/theme-provider';
import { useConfirm } from '../providers/dialog-provider';
import { hapticLight, hapticError } from '../lib/haptics';
import {
  isPreviewBuild,
  getEASConfig,
  fetchBranches,
  fetchChannels,
  findChannelIdByName,
  updateChannelBranchMapping,
  type EASBranch,
  type EASPlatform,
} from '../lib/eas-api';

function getEASPlatform(): EASPlatform {
  return Platform.OS === 'android' ? 'android' : 'ios';
}

function formatRelativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;

  if (diffMs < 0 || diffMs < 60_000) return 'just now';

  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;

  const diffMonths = Math.floor(diffDays / 30);
  return `${diffMonths}mo ago`;
}

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
export function BranchSwitcherScreen() {
  const { systemColors, spacing, borderRadius } = useTheme();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [switchingBranchId, setSwitchingBranchId] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const preview = isPreviewBuild();
  const easConfig = preview ? getEASConfig() : null;
  const token = easConfig?.token ?? '';
  const projectId = easConfig?.projectId ?? '';
  const easPlatform = getEASPlatform();
  const branchesQuery = useQuery({
    queryKey: ['eas-branches', projectId, easPlatform],
    queryFn: () => fetchBranches(projectId, token, easPlatform),
    staleTime: 60_000,
    enabled: preview,
  });

  const channelsQuery = useQuery({
    queryKey: ['eas-channels', projectId],
    queryFn: () => fetchChannels(projectId, token),
    staleTime: 60_000,
    enabled: preview,
  });
  const switchMutation = useMutation({
    mutationFn: async (branch: EASBranch) => {
      setSwitchingBranchId(branch.id);

      const channelsData = channelsQuery.data;
      if (!channelsData) throw new Error('Channels not loaded');
      const currentChannelName = Updates.channel ?? '';
      const currentChannelId = findChannelIdByName(channelsData, currentChannelName);
      if (!currentChannelId) {
        throw new Error(
          currentChannelName
            ? `Channel "${currentChannelName}" not found in EAS`
            : 'Current build has no channel — cannot switch branches',
        );
      }

      await updateChannelBranchMapping(currentChannelId, branch.id, token);

      const checkResult = await Updates.checkForUpdateAsync();
      if (!checkResult.isAvailable) {
        throw new Error('No compatible update available for this branch');
      }

      await Updates.fetchUpdateAsync();
      await Updates.reloadAsync();
    },
    onError: (mutationError: unknown) => {
      setSwitchingBranchId(null);
      hapticError();
      // i18n-ignore-next-line
      Alert.alert('Switch Failed', mutationError instanceof Error ? mutationError.message : 'Unknown error');
    },
  });
  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['eas-branches', projectId] }),
      queryClient.invalidateQueries({ queryKey: ['eas-channels', projectId] }),
    ]);
    setIsRefreshing(false);
  }, [queryClient, projectId]);

  const handleSwitchBranch = useCallback(
    async (branch: EASBranch) => {
      hapticLight();
      const confirmed = await confirm({
        // i18n-ignore-next-line — preview-only dev screen
        title: 'Switch Branch',
        // i18n-ignore-next-line
        message: `Switch to "${branch.name}"? The app will download the update and restart.`,
        // i18n-ignore-next-line
        confirmLabel: 'Switch',
        // i18n-ignore-next-line
        cancelLabel: 'Cancel',
      });
      if (!confirmed) return;
      switchMutation.mutate(branch);
    },
    [confirm, switchMutation],
  );
  if (!preview) {
    return null;
  }
  const currentChannel = Updates.channel ?? 'unknown';
  const currentBranch = getCurrentBranchName() ?? 'unknown';
  const currentUpdateId = Updates.updateId ?? null;
  const currentRuntimeVersion = Updates.runtimeVersion ?? 'unknown';
  const currentCreatedAt = Updates.createdAt ? Updates.createdAt.toISOString() : null;
  const isEmbedded = Updates.isEmbeddedLaunch;

  const isSwitching = switchingBranchId !== null;

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={handleRefresh} />}
    >
      {/* ---- Current Update Info ---- */}
      {/* i18n-ignore-next-line */}
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
        {isEmbedded ? (
          // i18n-ignore-next-line
          <InfoRow label="Status" value="No OTA update applied" showSeparator={false} />
        ) : (
          <>
            {/* i18n-ignore-next-line */}
            <InfoRow label="Channel" value={currentChannel} />
            {/* i18n-ignore-next-line */}
            <InfoRow label="Branch" value={currentBranch} />
            {currentUpdateId ? (
              // i18n-ignore-next-line
              <InfoRow label="Update ID" value={currentUpdateId.slice(0, 8)} />
            ) : null}
            {currentCreatedAt ? (
              // i18n-ignore-next-line
              <InfoRow label="Updated" value={formatRelativeTime(currentCreatedAt)} />
            ) : null}
            {/* i18n-ignore-next-line */}
            <InfoRow label="Runtime Version" value={currentRuntimeVersion} showSeparator={false} />
          </>
        )}
      </View>

      {/* ---- Available Branches ---- */}
      {/* i18n-ignore-next-line */}
      <SectionHeader title="Available Branches" />

      {branchesQuery.isLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator />
        </View>
      ) : branchesQuery.isError ? (
        <View style={[styles.errorContainer, { marginHorizontal: spacing[4] }]}>
          {/* i18n-ignore-next-line */}
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            {branchesQuery.error instanceof Error ? branchesQuery.error.message : 'Failed to load branches'}
          </Text>
          <Pressable
            onPress={() => {
              hapticLight();
              void branchesQuery.refetch();
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
      ) : branchesQuery.data ? (
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
          {branchesQuery.data.map((branch, index) => {
            const latestUpdate = branch.updates[0] ?? null;
            const isActive = branch.name === currentBranch;
            const isThisSwitching = switchingBranchId === branch.id;
            const isDisabled = isSwitching && !isThisSwitching;

            const subtitle = latestUpdate
              ? [latestUpdate.message, formatRelativeTime(latestUpdate.createdAt)].filter(Boolean).join(' · ')
              : undefined;

            const trailing = isThisSwitching ? (
              <ActivityIndicator size="small" />
            ) : isActive ? (
              <Icon name="check.small" size={20} color={systemColors.label} />
            ) : null;

            return (
              <ListRow
                key={branch.id}
                title={branch.name}
                subtitle={subtitle}
                trailing={trailing}
                onPress={isActive || isDisabled ? undefined : () => handleSwitchBranch(branch)}
                haptic={false}
                showSeparator={index < branchesQuery.data.length - 1}
                style={isDisabled ? styles.disabledRow : undefined}
              />
            );
          })}
        </View>
      ) : null}

      {/* Bottom spacing */}
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
