import { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import {
  AURORA_BOARDS,
  BOARD_DISPLAY_ORDER,
  type BoardName,
  type UserDataExportFormat,
} from '@boardsesh/shared-schema';
import { boardTypeLabel } from '@boardsesh/board-constants';
import { getOutboxSummary } from '@boardsesh/offline-sync';
import { getDatabaseHandle } from '../db';
import { useAuth } from '../providers/auth-provider';
import { useConfirm } from '../providers/dialog-provider';
import { useTheme } from '../providers/theme-provider';
import { captureAuthCredentialGeneration, isAuthCredentialGenerationCurrent } from '../lib/auth-store';
import { useProfile } from '../lib/graphql/hooks';
import { UserDataExportActionError, useUserDataExport } from '../lib/graphql/hooks/use-user-data-export';
import { isGraphqlRateLimitedError } from '../lib/graphql/extract-error-message';
import { withSettingTracking } from '../lib/settings-analytics';
import { spacing } from '../theme/tokens';
import { Button } from './Button';
import { MoreForm } from './MoreForm';
import { Text } from './Text';
import { buildUserDataExportModel } from './user-data-export-model';

// The board and format pickers choose what to download, not how the app
// behaves, so they stay out of the `Setting Changed` counts.
const UNTRACKED_EXPORT_ROWS: ReadonlySet<string> = new Set(['boardType', 'format']);

type ExportActionError =
  | 'outbox'
  | 'request'
  | 'download'
  | 'native_download'
  | 'share'
  | 'sharing_unavailable'
  | 'cleanup'
  | 'offline'
  | 'rate_limited'
  | null;

export function UserDataExportScreen() {
  const { isAuthenticated } = useAuth();
  const { t } = useTranslation('settings');
  const { systemColors } = useTheme();
  const profileQuery = useProfile({ enabled: isAuthenticated });
  const pageBackground = { backgroundColor: systemColors.groupedBackground };

  if (!isAuthenticated) {
    return (
      <View style={[styles.centered, pageBackground]}>
        <Text>{t('export.signIn')}</Text>
      </View>
    );
  }
  if (!profileQuery.data?.id) {
    return (
      <View style={[styles.centered, pageBackground]}>
        {profileQuery.isError ? (
          <>
            <Text>{t('export.loadFailed')}</Text>
            <Button title={t('export.refresh')} onPress={() => void profileQuery.refetch()} />
          </>
        ) : (
          <ActivityIndicator />
        )}
      </View>
    );
  }

  return (
    <AccountUserDataExportScreen
      key={`${profileQuery.data.id}:${captureAuthCredentialGeneration()}`}
      userId={profileQuery.data.id}
    />
  );
}

function AccountUserDataExportScreen({ userId }: { userId: string }) {
  const { t, i18n } = useTranslation('settings');
  const confirm = useConfirm();
  const [boardType, setBoardType] = useState<BoardName>(BOARD_DISPLAY_ORDER[0]);
  const [format, setFormat] = useState<UserDataExportFormat>('boardsesh');
  const [actionError, setActionError] = useState<ExportActionError>(null);
  const [preparingAction, setPreparingAction] = useState(false);
  const actionInFlight = useRef(false);
  const { statusQuery, requestMutation, downloadMutation, pollLimitReached, isOffline, refresh } = useUserDataExport(
    userId,
    boardType,
  );
  const busy = preparingAction || requestMutation.isPending || downloadMutation.isPending;
  const exportStatus = statusQuery.data;
  const selectedFile = exportStatus?.files.find((file) => file.format === format);
  const supportsAurora = AURORA_BOARDS.some((auroraBoard) => auroraBoard === boardType);
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }),
    [i18n.language],
  );
  const formatDate = useCallback((timestamp: string) => dateFormatter.format(new Date(timestamp)), [dateFormatter]);
  const boardOptions = useMemo(
    () =>
      BOARD_DISPLAY_ORDER.map((boardName) => ({
        key: boardName,
        label: boardName === 'spray' ? t('export.sprayWalls') : boardTypeLabel(boardName),
      })),
    [t],
  );
  const selectBoard = useCallback((boardKey: string) => {
    const nextBoard = BOARD_DISPLAY_ORDER.find((boardName) => boardName === boardKey);
    if (!nextBoard || actionInFlight.current) return;
    setBoardType(nextBoard);
    setFormat('boardsesh');
    setActionError(null);
  }, []);
  const selectFormat = useCallback((formatKey: string) => {
    if (actionInFlight.current) return;
    if (formatKey !== 'boardsesh' && formatKey !== 'aurora') return;
    setFormat(formatKey);
    setActionError(null);
  }, []);

  async function requestExport() {
    if (actionInFlight.current || isOffline) return;
    actionInFlight.current = true;
    setPreparingAction(true);
    setActionError(null);
    const credentialGeneration = captureAuthCredentialGeneration();
    try {
      // Read at the tap, not the debounced live counter. Dead letters are unsynced too.
      const database = getDatabaseHandle();
      let unsyncedCount = 0;
      try {
        const summary = database ? await getOutboxSummary(database) : null;
        unsyncedCount = (summary?.pendingCount ?? 0) + (summary?.deadLetterCount ?? 0);
      } catch {
        if (isAuthCredentialGenerationCurrent(credentialGeneration)) setActionError('outbox');
        return;
      }
      if (!isAuthCredentialGenerationCurrent(credentialGeneration)) return;
      if (unsyncedCount > 0) {
        const exportSynced = await confirm({
          title: t('export.unsyncedTitle'),
          message: t('export.unsyncedMessage', { count: unsyncedCount }),
          confirmLabel: t('export.exportSynced'),
          cancelLabel: t('export.waitForSync'),
        });
        if (!exportSynced || !isAuthCredentialGenerationCurrent(credentialGeneration)) return;
      }
      await requestMutation.mutateAsync();
    } catch (error) {
      if (!isAuthCredentialGenerationCurrent(credentialGeneration)) return;
      setActionError(
        error instanceof UserDataExportActionError && error.reason === 'offline'
          ? 'offline'
          : isGraphqlRateLimitedError(error)
            ? 'rate_limited'
            : 'request',
      );
    } finally {
      actionInFlight.current = false;
      setPreparingAction(false);
    }
  }

  async function downloadExport() {
    if (actionInFlight.current || isOffline || !exportStatus || !selectedFile) return;
    actionInFlight.current = true;
    setActionError(null);
    const credentialGeneration = captureAuthCredentialGeneration();
    try {
      await downloadMutation.mutateAsync({ period: exportStatus.period, format });
    } catch (error) {
      if (!isAuthCredentialGenerationCurrent(credentialGeneration)) return;
      if (error instanceof UserDataExportActionError) {
        switch (error.reason) {
          case 'session_changed':
            return;
          case 'offline':
            setActionError('offline');
            return;
          case 'browser_failed':
            setActionError('download');
            return;
          case 'download_failed':
            setActionError('native_download');
            return;
          case 'share_failed':
            setActionError('share');
            return;
          case 'sharing_unavailable':
            setActionError('sharing_unavailable');
            return;
          case 'cleanup_failed':
            setActionError('cleanup');
            return;
        }
      }
      setActionError(
        isGraphqlRateLimitedError(error) ? 'rate_limited' : Platform.OS === 'web' ? 'download' : 'native_download',
      );
    } finally {
      actionInFlight.current = false;
    }
  }

  const actionErrorCopy = (() => {
    switch (actionError) {
      case 'outbox':
        return t('export.outboxReadFailed');
      case 'request':
        return t('export.requestFailed');
      case 'download':
        return t('export.downloadFailed');
      case 'native_download':
        return t('export.nativeDownloadFailed');
      case 'share':
        return t('export.shareFailed');
      case 'sharing_unavailable':
        return t('export.sharingUnavailable');
      case 'cleanup':
        return t('export.cleanupFailed');
      case 'offline':
        return t('export.offline');
      case 'rate_limited':
        return t('export.rateLimited');
      default:
        return null;
    }
  })();
  const model = withSettingTracking(
    buildUserDataExportModel({
      t,
      isWeb: Platform.OS === 'web',
      boardOptions,
      boardType,
      onSelectBoard: selectBoard,
      supportsAurora,
      format,
      onSelectFormat: selectFormat,
      busy,
      isOffline,
      statusLoading: statusQuery.isLoading,
      statusError: statusQuery.isError,
      statusFetching: statusQuery.isFetching,
      exportStatus,
      pollLimitReached,
      requestPending: preparingAction || requestMutation.isPending,
      downloadPending: downloadMutation.isPending,
      actionErrorCopy,
      now: Date.now(),
      formatDate,
      onGenerate: () => void requestExport(),
      onDownload: () => void downloadExport(),
      onRefresh: () => {
        setActionError(null);
        void refresh();
      },
    }),
    'export',
    { skipKeys: UNTRACKED_EXPORT_ROWS },
  );

  return <MoreForm model={model} />;
}

const styles = StyleSheet.create({
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[3],
    paddingHorizontal: spacing[8],
  },
});
