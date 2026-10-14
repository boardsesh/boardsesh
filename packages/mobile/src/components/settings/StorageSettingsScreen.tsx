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
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useFocusEffect } from 'expo-router';
import { useOfflineDatabase } from '../../db/use-offline-database';
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
import { Button } from '../Button';
import { ActivityIndicator } from '../ActivityIndicator';
import { MoreForm } from '../MoreForm';
import { storageBoardLabel } from './storage-board-label';
import { buildStorageModel } from './storage-model';
import { useTheme } from '../../providers/theme-provider';
import { useConfirm } from '../../providers/dialog-provider';
import { useToast } from '../../providers/toast-provider';
import { useOfflineDownloadsEnabled } from '../../providers/feature-flags-provider';
import { useSetting, offlineBoardKey, forgetDownloadTrigger } from '../../settings';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '../../lib/analytics';
import { withSettingTracking } from '../../lib/settings-analytics';
import { isOfflineEngineEnabled } from '../../lib/offline-engine';
import {
  measureDatabaseBytes,
  measureFreeDiskSpace,
  isStorageScreenEmpty,
  RECLAIMABLE_VISIBLE_BYTES,
} from '../../db/storage-usage';
import { measureCachedImageBytes, clearCachedImages, type CachedImageMeasurement } from '../../lib/sweep-caches';
import { removeOfflineBoard, compactOfflineDatabase } from '../../offline/remove-offline-board';
import { formatStorageSize } from '../../lib/format-storage-size';
import { useOfflineSchemaReady } from '../../db/use-offline-schema-ready';
import { useOfflineSchemaDowngrade } from '../../db/use-offline-schema-downgrade';
import { reportError } from '../../lib/error-reporting';
import { hapticLight } from '../../lib/haptics';
import { spacing } from '../../theme/tokens';

type StorageMeasurement = {
  totalBytes: number;
  freeBytes: number | null;
  reclaimableBytes: number;
  /** Null where there is no cache directory to measure at all — the browser build. */
  cachedImages: CachedImageMeasurement | null;
  boards: { scopeKey: string; scope: OfflineBoardScope; climbCount: number; estimatedBytes: number }[];
};

/** Everything the Clear button reclaims, for the empty-state check and the button label. */
function totalCachedImageBytes(cachedImages: CachedImageMeasurement | null): number {
  if (!cachedImages) return 0;
  return cachedImages.artBytes + (cachedImages.photoBytes ?? 0) + cachedImages.leftoverSnapshotBytes;
}

export function StorageSettingsScreen() {
  const { t } = useTranslation('common');
  const { systemColors } = useTheme();
  const confirm = useConfirm();
  const { showToast } = useToast();
  // Not `useSQLiteContext()` directly: a dead-handle recovery opens a REPLACEMENT
  // connection without the provider ever re-rendering, so the context value would
  // still be the wrapper around the dead native instance (#5410).
  const db = useOfflineDatabase();
  // Live as soon as the launch gate opens — after the first init attempt, whatever
  // it did — so on a contended launch this connection has no tables yet. Folded into
  // the query KEY below rather than gating the query: a failed measurement renders
  // the existing error state with its Retry, and a late readiness flip re-measures.
  const schemaReady = useOfflineSchemaReady();
  // The file was migrated by a newer app version than this one, so `db` above
  // refuses every call. Nothing can be measured, and saying "couldn't measure,
  // try again" would be a lie with a button that cannot work.
  const schemaDowngrade = useOfflineSchemaDowngrade();
  const queryClient = useQueryClient();
  const offlineEnabled = useOfflineDownloadsEnabled();
  const [enabledBoards] = useSetting('syncEnabledBoards');
  const [removingScopeKey, setRemovingScopeKey] = useState<string | null>(null);
  const [isRemovingAll, setIsRemovingAll] = useState(false);
  const [isCompacting, setIsCompacting] = useState(false);
  const [isClearingCache, setIsClearingCache] = useState(false);

  const {
    data: measurement,
    isLoading,
    isError,
    isRefetching,
    refetch,
  } = useQuery<StorageMeasurement>({
    queryKey: ['offlineStorage', schemaReady],
    enabled: schemaDowngrade === null,
    // Not a poll: this walks 200k+ rows per scope in the worst case.
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
        // Memoized for a minute behind cache-size-meter, so the focus refetch
        // above doesn't re-walk a few thousand PNGs every time you tab back.
        cachedImages: await measureCachedImageBytes(),
        // A scope with no rows left is nothing to manage — don't offer a Remove that
        // would free nothing.
        boards: usage.filter((entry) => entry.climbCount > 0),
      };
    },
  });

  // Re-measure whenever the screen comes back into view, NOT just on mount: the
  // router keeps this screen mounted while you nav to My Boards, download a board,
  // and come back — so a mount-only refetch never fires and the stale (empty)
  // measurement renders "Nothing downloaded yet" over a board that just landed.
  // A download completing elsewhere has no reason to invalidate this query, so focus
  // is the only reliable signal that the number might have moved.
  useFocusEffect(
    useCallback(() => {
      void refetch();
    }, [refetch]),
  );

  const unknownScopeLabel = useCallback(
    (parts: { layoutId: number; sizeId: number }) => t('mobile.settings.storage.unknownScope', parts),
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
          caption: t('mobile.settings.storage.rowCaption', {
            size: formatStorageSize(board.estimatedBytes),
            count: board.climbCount,
          }),
          statusLabel: enabledSet.has(board.scopeKey)
            ? t('mobile.settings.storage.keptOffline')
            : t('mobile.settings.storage.notKeptOffline'),
        },
      ];
    });
  }, [measurement?.boards, enabledBoards, unknownScopeLabel, t]);

  const runRemoval = useCallback(
    async (scopes: OfflineBoardScope[]) => {
      try {
        for (const scope of scopes) {
          const scopeKey = offlineBoardKey(scope);
          await removeOfflineBoard({ db, queryClient, scope });
          // Removing storage IS turning the board off (issue #4316) — same
          // funnel exit as the My Boards toggle, different surface.
          forgetDownloadTrigger(scopeKey);
          track(SHARED_EVENTS.OfflineBoardToggled, {
            scopeKey,
            enabled: false,
            source: 'storage',
            offlineEngineEnabled: isOfflineEngineEnabled(),
          });
        }
        // Once, after every teardown — it rebuilds the whole file. Cosmetic by
        // design: a failure means the rows are gone but the file didn't shrink, so it
        // must never read as "the removal failed".
        //
        // Deferred while a pull is in flight: VACUUM's exclusive lock would fail a
        // concurrent import (issue #4370), and a board removal must not cost the
        // boards it deliberately spared. 'deferred' is silent — the reclaimable
        // banner below offers the manual Compact.
        const compacted = await compactOfflineDatabase(db, { deferWhileSyncing: true });
        if (compacted === 'not-truncated') showToast(t('mobile.settings.storage.compactFailed'), 'error');
        await refetch();
        return true;
      } catch (error) {
        reportError(error, { tags: { source: 'offline-sync', kind: 'scope-teardown' } });
        showToast(t('mobile.settings.storage.removeError'), 'error');
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
        title: t('mobile.settings.storage.removeTitle', { name: board.title }),
        message: t('mobile.settings.storage.removeMessage', { size: formatStorageSize(board.estimatedBytes) }),
        confirmLabel: t('mobile.settings.storage.removeConfirm'),
        cancelLabel: t('mobile.settings.storage.cancel'),
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
      title: t('mobile.settings.storage.removeAllTitle'),
      message: t('mobile.settings.storage.removeAllMessage', {
        size: formatStorageSize(rows.reduce((sum, row) => sum + row.estimatedBytes, 0)),
      }),
      confirmLabel: t('mobile.settings.storage.removeAllConfirm'),
      cancelLabel: t('mobile.settings.storage.cancel'),
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

  // A compaction that didn't land leaves the rows gone but the pages still reserved,
  // so the user's storage figure never moved. That's the one case worth offering a
  // manual retry for — see RECLAIMABLE_VISIBLE_BYTES for why it isn't `> 0`.
  const hasReclaimable = (measurement?.reclaimableBytes ?? 0) >= RECLAIMABLE_VISIBLE_BYTES;

  const handleCompact = useCallback(async () => {
    hapticLight();
    setIsCompacting(true);
    try {
      // Deliberate and blocking, so it aborts in-flight cycles rather than
      // deferring: they resume from their checkpoints next foreground with no
      // burned bootstrap attempt.
      const compacted = await compactOfflineDatabase(db, { deferWhileSyncing: false });
      if (compacted === 'not-truncated') showToast(t('mobile.settings.storage.compactFailed'), 'error');
      await refetch();
    } finally {
      setIsCompacting(false);
    }
  }, [db, showToast, t, refetch]);

  const cachedImages = measurement?.cachedImages ?? null;
  const cachedImageBytes = totalCachedImageBytes(cachedImages);

  const handleClearCachedImages = useCallback(async () => {
    hapticLight();
    const confirmed = await confirm({
      title: t('mobile.settings.storage.clearCachedImagesTitle'),
      message: t('mobile.settings.storage.clearCachedImagesMessage', { size: formatStorageSize(cachedImageBytes) }),
      confirmLabel: t('mobile.settings.storage.clearCachedImagesConfirm'),
      cancelLabel: t('mobile.settings.storage.cancel'),
      destructive: true,
    });
    if (!confirmed) return;
    setIsClearingCache(true);
    try {
      const result = await clearCachedImages();
      // expo-image resolves FALSE rather than throwing when it declines to clear
      // its disk cache (Android with no current activity), so the board art is
      // gone but the photos are not. Saying "done" there would be a lie the next
      // measurement immediately contradicts.
      showToast(
        result.photoCacheCleared
          ? t('mobile.settings.storage.clearCachedImagesDone')
          : t('mobile.settings.storage.clearCachedImagesPartial'),
        result.photoCacheCleared ? 'success' : 'warning',
      );
    } catch (error) {
      reportError(error, { tags: { source: 'offline-sync', kind: 'cache-clear' } });
      showToast(t('mobile.settings.storage.clearCachedImagesError'), 'error');
    } finally {
      setIsClearingCache(false);
      await refetch();
    }
  }, [confirm, t, cachedImageBytes, showToast, refetch]);

  const handleRemoveBoard = useCallback((scopeKey: string) => void handleRemove(scopeKey), [handleRemove]);
  const handleRemoveAllPress = useCallback(() => void handleRemoveAll(), [handleRemoveAll]);
  const handleCompactPress = useCallback(() => void handleCompact(), [handleCompact]);
  const handleClearCachedImagesPress = useCallback(() => void handleClearCachedImages(), [handleClearCachedImages]);

  const model = useMemo(
    () =>
      measurement
        ? withSettingTracking(
            buildStorageModel({
              t,
              formatSize: formatStorageSize,
              offlineEnabled,
              totalBytes: measurement.totalBytes,
              freeBytes: measurement.freeBytes,
              reclaimableBytes: measurement.reclaimableBytes,
              showReclaimable: hasReclaimable,
              cachedImages,
              boards: rows,
              removingScopeKey,
              isRemovingAll,
              isCompacting,
              isClearingCache,
              onRemoveBoard: handleRemoveBoard,
              onRemoveAll: handleRemoveAllPress,
              onCompact: handleCompactPress,
              onClearCachedImages: handleClearCachedImagesPress,
            }),
            'storage',
          )
        : null,
    [
      measurement,
      t,
      offlineEnabled,
      hasReclaimable,
      cachedImages,
      rows,
      removingScopeKey,
      isRemovingAll,
      isCompacting,
      isClearingCache,
      handleRemoveBoard,
      handleRemoveAllPress,
      handleCompactPress,
      handleClearCachedImagesPress,
    ],
  );

  // The full-page states sit on the same grouped ground the form draws, so
  // nothing flashes when the measurement lands and the form takes over.
  const pageBackground = { backgroundColor: systemColors.groupedBackground };

  if (schemaDowngrade !== null) {
    return (
      <View style={[styles.centered, pageBackground]}>
        <Icon name="boards" size={48} color={systemColors.tertiaryLabel} />
        <Text variant="headline" style={styles.stateTitle}>
          {t('mobile.settings.storage.downgradeTitle')}
        </Text>
        <Text variant="subheadline" style={styles.stateSubtitle}>
          {t('mobile.settings.storage.downgradeSubtitle')}
        </Text>
      </View>
    );
  }

  // Also spin while re-measuring over an empty cached result: a board downloaded
  // while this screen was unmounted would otherwise flash "Nothing downloaded yet"
  // until the refetch lands, which reads as "your download is gone".
  if (isLoading || (isRefetching && (measurement?.boards.length ?? 0) === 0)) {
    return (
      <View style={[styles.centered, pageBackground]}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (isError || !measurement || !model) {
    return (
      <View style={[styles.centered, pageBackground]}>
        <Icon name="error" size={40} color={systemColors.error} />
        <Text variant="headline" style={styles.stateTitle}>
          {t('mobile.settings.storage.errorTitle')}
        </Text>
        <Text variant="subheadline" style={styles.stateSubtitle}>
          {t('mobile.settings.storage.errorSubtitle')}
        </Text>
        <Button
          title={t('mobile.settings.storage.errorRetry')}
          variant="outlined"
          loading={isRefetching}
          onPress={() => void refetch()}
          style={styles.stateButton}
        />
      </View>
    );
  }

  // Nothing downloaded AND nothing held back: the plain empty state. When there IS
  // reserved space, fall through to the full screen instead — that's the case where
  // a compaction failed after the last board was removed, and a bare empty state
  // would hide the total, the free-space figure, and the only way to retry.
  if (
    isStorageScreenEmpty({
      boardCount: rows.length,
      reclaimableBytes: measurement.reclaimableBytes,
      cachedImageBytes,
    })
  ) {
    return (
      <View style={[styles.centered, pageBackground]}>
        <Icon name="boards" size={48} color={systemColors.tertiaryLabel} />
        <Text variant="headline" style={styles.stateTitle}>
          {t('mobile.settings.storage.emptyTitle')}
        </Text>
        <Text variant="subheadline" style={styles.stateSubtitle}>
          {t('mobile.settings.storage.emptySubtitle')}
        </Text>
      </View>
    );
  }

  return <MoreForm model={model} />;
}

const styles = StyleSheet.create({
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing[8],
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
});
