import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { randomUUID } from 'expo-crypto';
import { useSQLiteContext } from 'expo-sqlite';
import { isScopeDownloadComplete, offlineBoardKeyForBoard } from '@boardsesh/offline-sync';
import { toBoardName } from '@boardsesh/board-config';
import { BoardForm } from '../../src/components/board-discovery/BoardForm';
import { OfflineDownloadProgressBar } from '../../src/components/board-discovery/OfflineDownloadProgressBar';
import { boardDownloadProgress } from '../../src/components/board-discovery/board-offline-state';
import { formatDefaultBoardName } from '../../src/components/board-discovery/board-builder-labels';
import { useBoardBuilder, type BoardBuilderSeed } from '../../src/components/board-discovery/use-board-builder';
import { ActivityIndicator } from '../../src/components/ActivityIndicator';
import { Button } from '../../src/components/Button';
import { Text } from '../../src/components/Text';
import { useSetActiveBoard } from '../../src/lib/graphql/use-active-board';
import { createLocalBoard, type LocalBoard } from '../../src/lib/boards/local-board';
import {
  clearPendingLocalBoardSetup,
  getLocalBoard,
  getPendingLocalBoardSetup,
  saveLocalBoard,
  savePendingLocalBoardSetup,
  type PendingLocalBoardSetup,
} from '../../src/lib/boards/local-board-store';
import { formatBytes } from '../../src/lib/format-bytes';
import { useBoardDownloads } from '../../src/offline/use-board-downloads';
import { useConfirmBoardDownload } from '../../src/offline/use-confirm-board-download';
import { useDownloadedScopeKeys } from '../../src/offline/use-downloaded-scope-keys';
import { useSnapshotSource } from '../../src/offline/use-snapshot-source';
import { useAuth } from '../../src/providers/auth-provider';
import { usePartyProfile } from '../../src/providers/party-profile-provider';
import { useTheme } from '../../src/providers/theme-provider';
import { useSyncStatus } from '../../src/sync';
import { borderRadius, spacing } from '../../src/theme/tokens';
import { iosSystemColors } from '../../src/theme/ios-colors';

type LoadedSetup = {
  pending: PendingLocalBoardSetup | null;
  saved: LocalBoard | null;
};

function boardSeed(board: LocalBoard | null): BoardBuilderSeed | null {
  if (!board) return null;
  const boardName = toBoardName(board.boardType);
  if (!boardName) return null;
  return {
    boardName,
    layoutId: board.layoutId,
    sizeId: board.sizeId,
    setIds: board.setIds,
    angle: board.angle,
    name: board.name,
    isAngleAdjustable: board.isAngleAdjustable,
  };
}

export default function LocalBoardSetupScreen() {
  const [loadedSetup, setLoadedSetup] = useState<LoadedSetup | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const { t } = useTranslation('boards');

  useEffect(() => {
    let mounted = true;
    void Promise.all([getPendingLocalBoardSetup(), getLocalBoard()])
      .then(([pending, saved]) => {
        if (mounted) setLoadedSetup({ pending, saved });
      })
      .catch(() => {
        if (mounted) setLoadError(true);
      });
    return () => {
      mounted = false;
    };
  }, [loadAttempt]);

  if (loadError) {
    return (
      <SetupMessage title={t('mobile.localSetup.loadError')}>
        <Button
          title={t('mobile.localSetup.retry')}
          variant="filled"
          onPress={() => {
            setLoadError(false);
            setLoadAttempt((attempt) => attempt + 1);
          }}
        />
      </SetupMessage>
    );
  }

  if (!loadedSetup) {
    return (
      <SetupMessage title={t('mobile.localSetup.loading')}>
        <ActivityIndicator size="large" />
      </SetupMessage>
    );
  }

  const initialBoard = loadedSetup.pending?.board ?? loadedSetup.saved;
  return (
    <LoadedLocalBoardSetup
      key={initialBoard?.uuid ?? 'new-local-board'}
      initialPending={loadedSetup.pending}
      initialSaved={loadedSetup.saved}
    />
  );
}

function LoadedLocalBoardSetup({
  initialPending,
  initialSaved,
}: {
  initialPending: PendingLocalBoardSetup | null;
  initialSaved: LocalBoard | null;
}) {
  const router = useRouter();
  const db = useSQLiteContext();
  const { t, i18n } = useTranslation('boards');
  const { systemColors } = useTheme();
  const { profile: partyProfile, isLoading: partyProfileLoading } = usePartyProfile();
  const { setLocalCatalogReady } = useAuth();
  const setActiveBoard = useSetActiveBoard();
  const { confirmAndDownload } = useConfirmBoardDownload({ prefetchManifest: false });
  const { enableBoardsOffline } = useBoardDownloads();
  const snapshotSource = useSnapshotSource();
  const { data: downloadedScopeKeys } = useDownloadedScopeKeys();
  const syncStatus = useSyncStatus();
  const [pending, setPending] = useState(initialPending);
  const [saved] = useState(initialSaved);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const completionInFlightRef = useRef(false);

  const currentBoard = pending?.board ?? saved;
  const builder = useBoardBuilder(boardSeed(currentBoard));
  const selectedSize = useMemo(
    () => builder.sizes.find((size) => size.id === builder.sizeId) ?? null,
    [builder.sizes, builder.sizeId],
  );
  const defaultName = useMemo(
    () =>
      currentBoard?.name ??
      formatDefaultBoardName({
        boardName: builder.boardName,
        layoutName: builder.rawLayoutName,
        size: selectedSize,
      }),
    [currentBoard?.name, builder.boardName, builder.rawLayoutName, selectedSize],
  );
  const scopeKey = currentBoard ? offlineBoardKeyForBoard(currentBoard) : null;

  const finishSetup = useCallback(
    async (board: LocalBoard, reenableScope: boolean): Promise<void> => {
      if (completionInFlightRef.current) return;
      completionInFlightRef.current = true;
      try {
        const durable = await isScopeDownloadComplete(db, offlineBoardKeyForBoard(board));
        if (!durable) return;

        await saveLocalBoard(board);
        if (reenableScope) enableBoardsOffline(board);
        await setActiveBoard(board);
        await clearPendingLocalBoardSetup();
        await setLocalCatalogReady(true);
        router.replace('/(tabs)/climbs');
      } catch {
        setErrorMessage(t('mobile.localSetup.finishError'));
      } finally {
        completionInFlightRef.current = false;
      }
    },
    [db, enableBoardsOffline, router, setActiveBoard, setLocalCatalogReady, t],
  );

  useEffect(() => {
    if (!currentBoard || !scopeKey || !downloadedScopeKeys?.includes(scopeKey)) return;
    const mayFinish = pending?.phase === 'downloading' || (!pending && saved !== null);
    if (!mayFinish) return;
    void finishSetup(currentBoard, pending === null);
  }, [currentBoard, downloadedScopeKeys, finishSetup, pending, saved, scopeKey]);

  const handleSubmit = useCallback(async () => {
    if (submitting) return;
    if (!snapshotSource) {
      setErrorMessage(t('mobile.localSetup.snapshotUnavailable'));
      return;
    }
    const input = builder.buildCreateInput(defaultName);
    if (!input || partyProfileLoading) return;

    setSubmitting(true);
    setErrorMessage(null);
    const existingBoard = currentBoard;
    const uuid = existingBoard?.uuid ?? randomUUID();
    const board = createLocalBoard(input, {
      uuid,
      ownerId: existingBoard?.ownerId ?? partyProfile?.id ?? uuid,
      createdAt: existingBoard?.createdAt ?? new Date().toISOString(),
    });
    const awaitingConsent: PendingLocalBoardSetup = { version: 1, board, phase: 'awaiting-consent' };

    try {
      await savePendingLocalBoardSetup(awaitingConsent);
      setPending(awaitingConsent);
      const confirmed = await confirmAndDownload(board, { trigger: 'adopt-confirmed', source: 'adopt' });
      if (!confirmed) return;
      const downloading: PendingLocalBoardSetup = { version: 1, board, phase: 'downloading' };
      await savePendingLocalBoardSetup(downloading);
      setPending(downloading);
    } catch {
      setErrorMessage(t('mobile.localSetup.startError'));
    } finally {
      setSubmitting(false);
    }
  }, [
    builder,
    confirmAndDownload,
    currentBoard,
    defaultName,
    partyProfile?.id,
    partyProfileLoading,
    snapshotSource,
    submitting,
    t,
  ]);

  const handleRetryDownload = useCallback(() => {
    if (!currentBoard || !snapshotSource) {
      setErrorMessage(t('mobile.localSetup.snapshotUnavailable'));
      return;
    }
    setErrorMessage(null);
    enableBoardsOffline(currentBoard, { trigger: 'retry', source: 'adopt' });
  }, [currentBoard, enableBoardsOffline, snapshotSource, t]);

  if (pending?.phase === 'downloading' && currentBoard && scopeKey) {
    const { progress, isSyncing } = syncStatus;
    const downloadProgress = boardDownloadProgress({
      scopeKey,
      isSyncing,
      phase: progress?.phase,
      currentTable: progress?.currentTable ?? null,
      snapshot: progress?.snapshot,
      progressEnabled: true,
    });
    let statusText = t('mobile.localSetup.waiting');
    if (downloadProgress?.stage === 'manifest') {
      statusText = t('mobile.offline.bootstrapPreparing');
    } else if (downloadProgress?.stage === 'download') {
      statusText =
        downloadProgress.bytesDone !== null && downloadProgress.bytesTotal !== null
          ? t('mobile.offline.bootstrapDownloading', {
              done: formatBytes(downloadProgress.bytesDone, i18n.language),
              total: formatBytes(downloadProgress.bytesTotal, i18n.language),
            })
          : t('mobile.offline.bootstrapping');
    } else if (downloadProgress?.stage === 'import') {
      statusText = t('mobile.offline.bootstrapImporting');
    } else if (isSyncing) {
      statusText = t('mobile.offline.finalizing');
    }

    return (
      <View style={styles.downloadScreen}>
        <View style={[styles.downloadCard, { backgroundColor: systemColors.secondaryBackground }]}>
          <ActivityIndicator size="large" />
          <Text variant="title2" style={styles.centeredText}>
            {t('mobile.localSetup.downloadTitle', { name: currentBoard.name })}
          </Text>
          <Text variant="body" color={systemColors.secondaryLabel} style={styles.centeredText}>
            {statusText}
          </Text>
          <View style={styles.progressWidth}>
            <OfflineDownloadProgressBar fraction={downloadProgress?.fraction ?? null} />
          </View>
          {errorMessage || progress?.failed ? (
            <Text variant="footnote" color={iosSystemColors.systemRed} style={styles.centeredText}>
              {errorMessage ?? t('mobile.localSetup.downloadError')}
            </Text>
          ) : null}
          <Button title={t('mobile.localSetup.retry')} variant="text" onPress={handleRetryDownload} />
        </View>
      </View>
    );
  }

  return (
    <BoardForm
      presentation="local"
      builder={builder}
      defaultName={defaultName}
      submitting={submitting || partyProfileLoading}
      errorMessage={errorMessage}
      onSubmit={() => void handleSubmit()}
      submitLabel={t('mobile.localSetup.continue')}
    />
  );
}

function SetupMessage({ children, title }: { children: ReactNode; title: string }) {
  const { systemColors } = useTheme();
  return (
    <View style={styles.downloadScreen}>
      <View style={[styles.downloadCard, { backgroundColor: systemColors.secondaryBackground }]}>
        <Text variant="headline" style={styles.centeredText}>
          {title}
        </Text>
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  downloadScreen: {
    flex: 1,
    justifyContent: 'center',
    padding: spacing[4],
  },
  downloadCard: {
    alignItems: 'center',
    gap: spacing[4],
    padding: spacing[6],
    borderRadius: borderRadius.xl,
  },
  centeredText: {
    textAlign: 'center',
  },
  progressWidth: {
    alignSelf: 'stretch',
  },
});
