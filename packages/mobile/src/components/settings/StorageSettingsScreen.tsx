// Manage Storage (issue #3617): what offline mode occupies on this device, and the
// only way to get it back.
//
// Two constraints shape this screen:
//
// - It must work with NO network and NO auth. It's the screen you open because the
//   device is full, quite possibly in a gym basement. Every label resolves from
//   bundled static data (storage-board-label.ts) and every number from local SQLite.
// - It lists scopes that have ROWS, not scopes that are enabled. Turning a board's
//   offline toggle off has never deleted anything, so "downloaded but not kept
//   offline" is the most likely row here — it's exactly the leftover data this screen
//   exists to reclaim, and it would be invisible if we listed the setting instead.

import { useCallback, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSQLiteContext } from 'expo-sqlite';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getDownloadedScopeKeys,
  getScopeUsage,
  measureReclaimableBytes,
  parseOfflineBoardKey,
  type OfflineBoardScope,
} from '@boardsesh/offline-sync';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Card } from '../Card';
import { Button } from '../Button';
import { ListRow } from '../ListRow';
import { SectionHeader } from '../SectionHeader';
import { ActivityIndicator } from '../ActivityIndicator';
import { StorageBoardRow } from './StorageBoardRow';
import { storageBoardLabel } from './storage-board-label';
import { useTheme } from '../../providers/theme-provider';
import { useConfirm } from '../../providers/dialog-provider';
import { useToast } from '../../providers/toast-provider';
import { useOfflineDownloadsEnabled } from '../../providers/feature-flags-provider';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { useSetting } from '../../settings';
import { measureDatabaseBytes, measureFreeDiskSpace } from '../../db/storage-usage';
import { removeOfflineBoard, compactOfflineDatabase } from '../../offline/remove-offline-board';
import { formatStorageSize } from '../../lib/format-storage-size';
import { reportError } from '../../lib/error-reporting';
import { hapticLight } from '../../lib/haptics';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing, borderRadius } from '../../theme/tokens';

type StorageMeasurement = {
  totalBytes: number;
  freeBytes: number | null;
  reclaimableBytes: number;
  boards: { scopeKey: string; scope: OfflineBoardScope; climbCount: number; estimatedBytes: number }[];
};

export function StorageSettingsScreen() {
  const { t } = useTranslation('common');
  const { systemColors } = useTheme();
  const confirm = useConfirm();
  const { showToast } = useToast();
  const db = useSQLiteContext();
  const queryClient = useQueryClient();
  const bottomChrome = useBottomChromeMetrics();
  const offlineEnabled = useOfflineDownloadsEnabled();
  const [enabledBoards] = useSetting('syncEnabledBoards');
  const [removingScopeKey, setRemovingScopeKey] = useState<string | null>(null);
  const [isRemovingAll, setIsRemovingAll] = useState(false);

  const {
    data: measurement,
    isLoading,
    isError,
    isRefetching,
    refetch,
  } = useQuery<StorageMeasurement>({
    queryKey: ['offlineStorage'],
    // Not a poll: this walks 200k+ rows per scope in the worst case. It refetches on
    // mount and after a removal, which is every moment the number can change while
    // the user is looking at it.
    refetchOnWindowFocus: false,
    queryFn: async () => {
      // Scopes with rows, unioned with the enabled set so a scope whose download was
      // interrupted before it ever checkpointed still shows up and stays reclaimable.
      const downloaded = await getDownloadedScopeKeys(db);
      const scopeKeys = [...new Set([...downloaded, ...enabledBoards])];
      const scopes = scopeKeys
        .map((scopeKey) => ({ scopeKey, scope: parseOfflineBoardKey(scopeKey) }))
        .filter((entry): entry is { scopeKey: string; scope: OfflineBoardScope } => entry.scope !== null);

      const usage = await getScopeUsage(db, scopes);
      return {
        totalBytes: measureDatabaseBytes(),
        freeBytes: measureFreeDiskSpace(),
        reclaimableBytes: await measureReclaimableBytes(db),
        // A scope with no rows left is nothing to manage — don't offer a Remove that
        // would free nothing.
        boards: usage.filter((entry) => entry.climbCount > 0),
      };
    },
  });

  const unknownScopeLabel = useCallback(
    (parts: { layoutId: number; sizeId: number }) => t('mobile.more.storage.unknownScope', parts),
    [t],
  );

  const rows = useMemo(() => {
    const enabledSet = new Set(enabledBoards);
    return (measurement?.boards ?? []).flatMap((board) => {
      const label = storageBoardLabel(board.scopeKey, unknownScopeLabel);
      // A malformed key has no rows behind it worth a Remove button.
      if (!label) return [];
      return [
        {
          ...board,
          title: label.title,
          subtitle: label.subtitle,
          caption: t('mobile.more.storage.rowCaption', {
            size: formatStorageSize(board.estimatedBytes),
            count: board.climbCount,
          }),
          statusLabel: enabledSet.has(board.scopeKey)
            ? t('mobile.more.storage.keptOffline')
            : t('mobile.more.storage.notKeptOffline'),
        },
      ];
    });
  }, [measurement?.boards, enabledBoards, unknownScopeLabel, t]);

  const runRemoval = useCallback(
    async (scopes: OfflineBoardScope[]) => {
      try {
        for (const scope of scopes) {
          await removeOfflineBoard({ db, queryClient, scope });
        }
        // Once, after every teardown — it rebuilds the whole file. Cosmetic by
        // design: a failure means the rows are gone but the file didn't shrink, so it
        // must never read as "the removal failed".
        const compacted = await compactOfflineDatabase(db);
        if (!compacted) showToast(t('mobile.more.storage.compactFailed'), 'error');
        await refetch();
        return true;
      } catch (error) {
        reportError(error, { tags: { source: 'offline-sync', kind: 'scope-teardown' } });
        showToast(t('mobile.more.storage.removeError'), 'error');
        return false;
      }
    },
    [db, queryClient, showToast, t, refetch],
  );

  const handleRemove = useCallback(
    async (scopeKey: string) => {
      const board = rows.find((row) => row.scopeKey === scopeKey);
      if (!board) return;
      hapticLight();
      const confirmed = await confirm({
        title: t('mobile.more.storage.removeTitle', { name: board.title }),
        message: t('mobile.more.storage.removeMessage', { size: formatStorageSize(board.estimatedBytes) }),
        confirmLabel: t('mobile.more.storage.removeConfirm'),
        cancelLabel: t('mobile.more.storage.cancel'),
        destructive: true,
      });
      if (!confirmed) return;
      setRemovingScopeKey(scopeKey);
      try {
        await runRemoval([board.scope]);
      } finally {
        setRemovingScopeKey(null);
      }
    },
    [rows, confirm, t, runRemoval],
  );

  const handleRemoveAll = useCallback(async () => {
    hapticLight();
    const confirmed = await confirm({
      title: t('mobile.more.storage.removeAllTitle'),
      message: t('mobile.more.storage.removeAllMessage', {
        size: formatStorageSize(rows.reduce((sum, row) => sum + row.estimatedBytes, 0)),
      }),
      confirmLabel: t('mobile.more.storage.removeAllConfirm'),
      cancelLabel: t('mobile.more.storage.cancel'),
      destructive: true,
    });
    if (!confirmed) return;
    setIsRemovingAll(true);
    try {
      await runRemoval(rows.map((row) => row.scope));
    } finally {
      setIsRemovingAll(false);
    }
  }, [confirm, t, rows, runRemoval]);

  const isBusy = removingScopeKey !== null || isRemovingAll;

  if (isLoading) {
    return (
      <View style={[styles.centered, { backgroundColor: systemColors.background }]}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (isError || !measurement) {
    return (
      <View style={[styles.centered, { backgroundColor: systemColors.background }]}>
        <Icon name="error" size={40} color={iosSystemColors.systemRed} />
        <Text variant="headline" style={styles.stateTitle}>
          {t('mobile.more.storage.errorTitle')}
        </Text>
        <Text variant="subheadline" style={styles.stateSubtitle}>
          {t('mobile.more.storage.errorSubtitle')}
        </Text>
        <Button
          title={t('mobile.more.storage.errorRetry')}
          variant="outlined"
          loading={isRefetching}
          onPress={() => void refetch()}
          style={styles.stateButton}
        />
      </View>
    );
  }

  if (rows.length === 0) {
    return (
      <View style={[styles.centered, { backgroundColor: systemColors.background }]}>
        <Icon name="boards" size={48} color={systemColors.tertiaryLabel} />
        <Text variant="headline" style={styles.stateTitle}>
          {t('mobile.more.storage.emptyTitle')}
        </Text>
        <Text variant="subheadline" style={styles.stateSubtitle}>
          {t('mobile.more.storage.emptySubtitle')}
        </Text>
      </View>
    );
  }

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: systemColors.background }}
      contentContainerStyle={[styles.content, { paddingBottom: bottomChrome.scrollBottomPadding + spacing[4] }]}
    >
      <Text variant="footnote" style={[styles.intro, { color: systemColors.secondaryLabel }]}>
        {t('mobile.more.storage.intro')}
      </Text>

      {/* The flag is a kill switch; someone rolled back still has the gigabytes. */}
      {!offlineEnabled ? (
        <Text variant="footnote" style={[styles.intro, { color: systemColors.secondaryLabel }]}>
          {t('mobile.more.storage.offNote')}
        </Text>
      ) : null}

      {/* The measured total sits in its own card, above its own header, so the
          approximate per-board figures below are never read as summing into it. */}
      <Card style={styles.card}>
        <ListRow
          title={t('mobile.more.storage.totalLabel')}
          haptic={false}
          showSeparator={measurement.freeBytes !== null}
          trailing={<Text variant="body">{formatStorageSize(measurement.totalBytes)}</Text>}
        />
        {measurement.freeBytes !== null ? (
          <ListRow
            title={t('mobile.more.storage.freeLabel')}
            haptic={false}
            showSeparator={false}
            trailing={
              <Text variant="body" style={{ color: systemColors.secondaryLabel }}>
                {formatStorageSize(measurement.freeBytes)}
              </Text>
            }
          />
        ) : null}
      </Card>

      <SectionHeader title={t('mobile.more.storage.boardsHeader')} />
      <Card style={styles.card}>
        {rows.map((row, index) => (
          <StorageBoardRow
            key={row.scopeKey}
            scopeKey={row.scopeKey}
            title={row.title}
            subtitle={row.subtitle}
            caption={row.caption}
            statusLabel={row.statusLabel}
            removeLabel={t('mobile.more.storage.remove')}
            removeAccessibilityLabel={t('mobile.more.storage.removeAria', { name: row.title })}
            isRemoving={removingScopeKey === row.scopeKey}
            isDisabled={isBusy}
            showSeparator={index < rows.length - 1}
            onRemove={handleRemove}
          />
        ))}
      </Card>

      <Text variant="caption1" style={[styles.note, { color: systemColors.tertiaryLabel }]}>
        {t('mobile.more.storage.estimateNote')}
      </Text>

      <Button
        title={t('mobile.more.storage.removeAll')}
        variant="text"
        role="destructive"
        loading={isRemovingAll}
        disabled={removingScopeKey !== null}
        onPress={() => void handleRemoveAll()}
        style={styles.removeAll}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingTop: spacing[4],
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing[8],
  },
  intro: {
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[3],
  },
  card: {
    marginHorizontal: spacing[4],
    borderRadius: borderRadius.lg,
  },
  note: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
  },
  stateTitle: {
    marginTop: spacing[3],
    textAlign: 'center',
  },
  stateSubtitle: {
    marginTop: spacing[1],
    textAlign: 'center',
    opacity: 0.6,
  },
  stateButton: {
    marginTop: spacing[4],
  },
  removeAll: {
    marginTop: spacing[4],
    marginHorizontal: spacing[4],
  },
});
