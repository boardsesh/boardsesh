import { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';
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
import { borderRadius, spacing } from '../theme/tokens';
import { Button } from './Button';
import { RadioGroup } from './RadioGroup';
import { SectionHeader } from './SectionHeader';
import { Text } from './Text';

type ExportActionError = 'outbox' | 'request' | 'download' | 'offline' | 'rate_limited' | null;

export function UserDataExportScreen() {
  const { isAuthenticated } = useAuth();
  const { t } = useTranslation('settings');
  const profileQuery = useProfile({ enabled: isAuthenticated });

  if (!isAuthenticated) return <Text style={styles.copy}>{t('export.signIn')}</Text>;
  if (!profileQuery.data?.id) {
    return profileQuery.isError ? (
      <View style={styles.copy}>
        <Text>{t('export.loadFailed')}</Text>
        <Button title={t('export.refresh')} onPress={() => void profileQuery.refetch()} />
      </View>
    ) : (
      <ActivityIndicator style={styles.copy} />
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
  const { systemColors, brandColors } = useTheme();
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
  const formatDate = (timestamp: string) => dateFormatter.format(new Date(timestamp));
  const boardOptions = useMemo(
    () =>
      BOARD_DISPLAY_ORDER.map((boardName) => ({
        value: boardName,
        label: boardName === 'spray' ? t('export.sprayWalls') : boardTypeLabel(boardName),
        disabled: busy,
      })),
    [t, busy],
  );
  const formatOptions = useMemo(
    () => [
      { value: 'boardsesh' as const, label: t('export.boardseshFormat'), disabled: busy },
      { value: 'aurora' as const, label: t('export.auroraFormat'), disabled: busy },
    ],
    [t, busy],
  );
  const selectBoard = useCallback((nextBoard: BoardName) => {
    if (actionInFlight.current) return;
    setBoardType(nextBoard);
    setFormat('boardsesh');
    setActionError(null);
  }, []);
  const selectFormat = useCallback((nextFormat: UserDataExportFormat) => {
    if (actionInFlight.current) return;
    setFormat(nextFormat);
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
      setActionError(
        error instanceof UserDataExportActionError && error.reason === 'offline'
          ? 'offline'
          : isGraphqlRateLimitedError(error)
            ? 'rate_limited'
            : 'download',
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
      case 'offline':
        return t('export.offline');
      case 'rate_limited':
        return t('export.rateLimited');
      default:
        return null;
    }
  })();
  const retryWaiting = !!exportStatus?.retryAt && Date.parse(exportStatus.retryAt) > Date.now();
  const fileExpired = !!selectedFile && Date.parse(selectedFile.expiresAt) <= Date.now();

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.container}>
      <View style={styles.copy}>
        <Text variant="subheadline" color={systemColors.secondaryLabel}>
          {t('export.description')}
        </Text>
        <Text variant="footnote" color={systemColors.secondaryLabel}>
          {t('export.weekly')}
        </Text>
        <Text variant="footnote" color={systemColors.secondaryLabel}>
          {t('export.expiry')}
        </Text>
      </View>
      <SectionHeader title={t('export.boardType')} />
      <View style={styles.controls}>
        <RadioGroup options={boardOptions} value={boardType} onChange={selectBoard} />
      </View>
      <SectionHeader title={t('export.format')} />
      <View style={styles.controls}>
        {supportsAurora ? <RadioGroup options={formatOptions} value={format} onChange={selectFormat} /> : null}
        <Text variant="footnote" color={systemColors.secondaryLabel}>
          {format === 'boardsesh' ? t('export.boardseshDescription') : t('export.auroraDescription')}
        </Text>
      </View>
      <View style={[styles.statusCard, { backgroundColor: systemColors.secondaryBackground }]}>
        {isOffline ? <Text color={brandColors.warning}>{t('export.offline')}</Text> : null}
        {statusQuery.isLoading && !isOffline ? <ActivityIndicator /> : null}
        {statusQuery.isError ? <Text color={brandColors.error}>{t('export.loadFailed')}</Text> : null}
        {exportStatus?.status === 'not_requested' ? <Text>{t('export.notRequested')}</Text> : null}
        {exportStatus?.status === 'generating' ? (
          <>
            <ActivityIndicator />
            <Text>{pollLimitReached ? t('export.pollStopped') : t('export.generating')}</Text>
          </>
        ) : null}
        {exportStatus?.status === 'unavailable' ? <Text>{t('export.unavailable')}</Text> : null}
        {exportStatus?.status === 'failed' ? (
          <>
            <Text color={brandColors.error}>{t('export.failed')}</Text>
            {retryWaiting && exportStatus.retryAt ? (
              <Text>{t('export.retryAt', { date: formatDate(exportStatus.retryAt) })}</Text>
            ) : null}
          </>
        ) : null}
        {selectedFile || exportStatus?.status === 'ready' ? (
          <>
            <Text variant="headline">
              {exportStatus?.status === 'ready'
                ? t('export.ready')
                : format === 'boardsesh'
                  ? t('export.boardseshFormat')
                  : t('export.auroraFormat')}
            </Text>
            {selectedFile ? (
              <>
                <Text>{t('export.exportedAt', { date: formatDate(selectedFile.exportedAt) })}</Text>
                <Text>{t('export.expiresAt', { date: formatDate(selectedFile.expiresAt) })}</Text>
                {fileExpired ? <Text>{t('export.fileExpired')}</Text> : null}
              </>
            ) : (
              <Text>{t('export.formatUnavailable')}</Text>
            )}
            {exportStatus ? <Text>{t('export.refreshAt', { date: formatDate(exportStatus.refreshAt) })}</Text> : null}
            <Button
              title={t('export.download')}
              loading={downloadMutation.isPending}
              disabled={busy || isOffline || !selectedFile || fileExpired}
              onPress={() => void downloadExport()}
            />
          </>
        ) : null}
        {exportStatus && (exportStatus.status === 'not_requested' || exportStatus.status === 'failed') ? (
          <Button
            title={exportStatus.status === 'failed' ? t('export.retry') : t('export.generate')}
            loading={busy}
            disabled={busy || isOffline || retryWaiting}
            onPress={() => void requestExport()}
          />
        ) : null}
        {actionErrorCopy ? <Text color={brandColors.error}>{actionErrorCopy}</Text> : null}
        <Button
          title={t('export.refresh')}
          variant="outlined"
          loading={statusQuery.isFetching}
          disabled={busy || isOffline || statusQuery.isFetching}
          onPress={() => {
            setActionError(null);
            void refresh();
          }}
        />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { paddingVertical: spacing[4], paddingBottom: spacing[8] },
  copy: { marginHorizontal: spacing[4], gap: spacing[2], paddingVertical: spacing[2] },
  controls: { marginHorizontal: spacing[4], gap: spacing[3] },
  statusCard: { margin: spacing[4], padding: spacing[4], gap: spacing[3], borderRadius: borderRadius.lg },
});
