import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { File } from 'expo-file-system';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  AURORA_BOARDS,
  parseAuroraExportJson,
  type AuroraBoardName,
  type AuroraExportPreview,
  type ImportProgressEvent,
  type ImportResult,
  type StrippedAuroraExportData,
} from '@boardsesh/shared-schema';
import { Button } from '../Button';
import { Icon } from '../Icon';
import { SectionHeader } from '../SectionHeader';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { useToast } from '../../providers/toast-provider';
import { useConfirm } from '../../providers/dialog-provider';
import { borderRadius, spacing } from '../../theme/tokens';
import { iosSystemColors } from '../../theme/ios-colors';
import {
  BoardAccountError,
  connectKilterAccount,
  deleteAuroraCredential,
  getAuroraCredentials,
  getAuroraUnsyncedCounts,
  saveAuroraCredential,
  streamAuroraImport,
  type AuroraCredentialStatus,
  type UnsyncedCounts,
} from '../../lib/aurora-credentials';

type ImportPhase = 'preview' | 'importing' | 'complete' | 'error';
type ImportStep = 'climbs' | 'resolving' | 'dedup' | 'ascents' | 'attempts' | 'circuits';

type ImportProgress = {
  step: ImportStep;
  current?: number;
  total?: number;
};

const MAX_IMPORT_SIZE_BYTES = 200 * 1024 * 1024;
const IMPORT_RESULT_LIMIT = 8;
const AURORA_CREDENTIALS_QUERY_KEY = ['auroraCredentials'] as const;
const AURORA_UNSYNCED_QUERY_KEY = ['auroraCredentials', 'unsynced'] as const;

function boardDisplayName(boardType: AuroraBoardName): string {
  return boardType.charAt(0).toUpperCase() + boardType.slice(1);
}

function getCredential(credentials: AuroraCredentialStatus[] | undefined, boardType: AuroraBoardName) {
  return credentials?.find((credential) => credential.boardType === boardType) ?? null;
}

function getUnsyncedCount(counts: UnsyncedCounts | undefined, boardType: AuroraBoardName) {
  return counts?.[boardType] ?? { ascents: 0, climbs: 0 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function buildKilterDataRequestMailto(t: TFunction<'settings'>): string {
  const name = t('aurora.kilterEmail.namePlaceholder');
  const email = t('aurora.kilterEmail.emailPlaceholder');
  const subject = t('aurora.kilterEmail.subject');
  const body = t('aurora.kilterEmail.body', { name, email });
  return `mailto:peter@auroraclimbing.com?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function totalImported(result: ImportResult): number {
  return result.climbs.imported + result.ascents.imported + result.attempts.imported + result.circuits.imported;
}

function errorMessageFor(error: unknown, t: TFunction<'settings'>): string {
  if (error instanceof BoardAccountError) {
    switch (error.code) {
      case 'invalid_credentials':
        return t('aurora.mobile.invalidCredentials');
      case 'not_allowed':
        return t('aurora.mobile.kilterNotAllowed');
      case 'rate_limited':
        return t('aurora.mobile.rateLimited');
      case 'request_failed':
      case 'unauthorized':
        return t('aurora.mobile.requestFailed');
    }
  }
  return t('aurora.mobile.requestFailed');
}

export function BoardAccountsSection() {
  const { t } = useTranslation('settings');
  const { t: tCommon } = useTranslation('common');
  const { systemColors, brandColors, colorScheme } = useTheme();
  const { showToast } = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();

  const credentialsQuery = useQuery({
    queryKey: AURORA_CREDENTIALS_QUERY_KEY,
    queryFn: getAuroraCredentials,
  });
  const unsyncedQuery = useQuery({
    queryKey: AURORA_UNSYNCED_QUERY_KEY,
    queryFn: getAuroraUnsyncedCounts,
    enabled: credentialsQuery.isSuccess,
  });

  const [linkBoard, setLinkBoard] = useState<AuroraBoardName | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [connectingKilter, setConnectingKilter] = useState(false);
  const [importBoard, setImportBoard] = useState<AuroraBoardName | null>(null);
  const [importPreview, setImportPreview] = useState<AuroraExportPreview | null>(null);
  const [importData, setImportData] = useState<StrippedAuroraExportData | null>(null);
  const [importPhase, setImportPhase] = useState<ImportPhase | null>(null);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);

  const saveCredentialMutation = useMutation({
    mutationFn: saveAuroraCredential,
    onSuccess: async (_credential, variables) => {
      const boardName = boardDisplayName(variables.boardType);
      showToast(t('aurora.mobile.linkSuccess', { boardName }), 'success');
      setLinkBoard(null);
      setUsername('');
      setPassword('');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: AURORA_CREDENTIALS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: AURORA_UNSYNCED_QUERY_KEY }),
      ]);
    },
    onError: (error) => {
      showToast(errorMessageFor(error, t), 'error');
    },
  });

  const deleteCredentialMutation = useMutation({
    mutationFn: deleteAuroraCredential,
    onSuccess: async (result, boardType) => {
      const boardName = boardDisplayName(boardType);
      if (result.success) {
        showToast(t('aurora.mobile.unlinkSuccess', { boardName }), 'success');
      } else {
        showToast(t('aurora.mobile.unlinkPartial', { boardName }), 'warning');
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: AURORA_CREDENTIALS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: AURORA_UNSYNCED_QUERY_KEY }),
      ]);
    },
    onError: (error) => {
      showToast(errorMessageFor(error, t), 'error');
    },
  });

  const stepLabels = useMemo(
    () => ({
      climbs: t('aurora.import.steps.climbs'),
      resolving: t('aurora.import.steps.resolving'),
      dedup: t('aurora.import.steps.dedup'),
      ascents: t('aurora.import.steps.ascents'),
      attempts: t('aurora.import.steps.attempts'),
      circuits: t('aurora.import.steps.circuits'),
    }),
    [t],
  );

  const resetImport = useCallback(() => {
    setImportBoard(null);
    setImportPreview(null);
    setImportData(null);
    setImportPhase(null);
    setImportProgress(null);
    setImportResult(null);
  }, []);

  const handleOpenLink = useCallback((boardType: AuroraBoardName) => {
    setLinkBoard(boardType);
    setUsername('');
    setPassword('');
  }, []);

  const handleSubmitLink = useCallback(() => {
    if (!linkBoard) return;
    saveCredentialMutation.mutate({
      boardType: linkBoard,
      username: username.trim(),
      password,
    });
  }, [linkBoard, password, saveCredentialMutation, username]);

  const handleConnectKilter = useCallback(() => {
    setConnectingKilter(true);
    void (async () => {
      try {
        const result = await connectKilterAccount();
        if (result === 'connected') {
          showToast(t('aurora.mobile.kilterConnected'), 'success');
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: AURORA_CREDENTIALS_QUERY_KEY }),
            queryClient.invalidateQueries({ queryKey: AURORA_UNSYNCED_QUERY_KEY }),
          ]);
        } else if (result === 'not_allowed') {
          showToast(t('aurora.mobile.kilterNotAllowed'), 'error');
        } else if (result === 'error') {
          showToast(t('aurora.mobile.kilterConnectFailed'), 'error');
        }
      } finally {
        setConnectingKilter(false);
      }
    })();
  }, [queryClient, showToast, t]);

  const handleRequestData = useCallback(() => {
    void Linking.openURL(buildKilterDataRequestMailto(t)).catch(() => {
      showToast(t('aurora.mobile.requestDataFailed'), 'error');
    });
  }, [showToast, t]);

  const handleUnlink = useCallback(
    async (boardType: AuroraBoardName) => {
      const boardName = boardDisplayName(boardType);
      const confirmed = await confirm({
        title: t('aurora.card.unlinkConfirm.title'),
        message: t('aurora.card.unlinkConfirm.description', { boardName }),
        confirmLabel: t('aurora.card.unlink'),
        cancelLabel: tCommon('actions.cancel'),
        destructive: true,
      });
      if (!confirmed) return;
      deleteCredentialMutation.mutate(boardType);
    },
    [confirm, deleteCredentialMutation, t, tCommon],
  );

  const handleImportPress = useCallback(
    (boardType: AuroraBoardName) => {
      setImportBoard(boardType);
      void (async () => {
        try {
          const DocumentPicker = await import('expo-document-picker');
          const document = await DocumentPicker.getDocumentAsync({
            type: 'application/json',
            copyToCacheDirectory: true,
          });
          if (document.canceled) {
            setImportBoard(null);
            return;
          }

          const asset = document.assets[0];
          if (!asset) {
            setImportBoard(null);
            return;
          }
          if (asset.size != null && asset.size > MAX_IMPORT_SIZE_BYTES) {
            showToast(t('aurora.import.tooLarge'), 'error');
            setImportBoard(null);
            return;
          }

          const text = await new File(asset.uri).text();
          const parsedJson = JSON.parse(text) as unknown;
          if (!isRecord(parsedJson)) throw new Error('invalid_json');
          const parsed = parseAuroraExportJson(parsedJson, boardType);

          if (parsed.boardMismatchLayoutName) {
            showToast(
              t('aurora.mobile.importBoardWarning', {
                layoutName: parsed.boardMismatchLayoutName,
                boardName: boardDisplayName(boardType),
              }),
              'warning',
              5000,
            );
          }

          setImportData(parsed.data);
          setImportPreview(parsed.preview);
          setImportPhase('preview');
        } catch (error) {
          const message =
            error instanceof Error && error.message === 'missing_user'
              ? t('aurora.mobile.importMissingUser')
              : t('aurora.import.parseError');
          showToast(message, 'error');
          setImportBoard(null);
        }
      })();
    },
    [showToast, t],
  );

  const handleImportConfirm = useCallback(() => {
    if (!importBoard || !importData) return;

    setImportPhase('importing');
    setImportPreview(null);
    setImportProgress(null);
    setImportResult(null);

    void (async () => {
      try {
        await streamAuroraImport(importBoard, importData, (event: ImportProgressEvent) => {
          if (event.type === 'progress') {
            setImportProgress({
              step: event.step,
              current: 'current' in event ? event.current : undefined,
              total: 'total' in event ? event.total : undefined,
            });
            return;
          }

          if (event.type === 'complete') {
            setImportResult(event.results);
            setImportPhase('complete');
            showToast(
              event.results.partialError
                ? t('aurora.mobile.importPartial')
                : t('aurora.import.successCount', { count: totalImported(event.results) }),
              event.results.partialError ? 'warning' : 'success',
            );
            void queryClient.invalidateQueries({ queryKey: AURORA_UNSYNCED_QUERY_KEY });
            return;
          }

          setImportPhase('error');
          showToast(t('aurora.mobile.importFailed'), 'error');
        });
      } catch {
        setImportPhase('error');
        showToast(t('aurora.mobile.importFailed'), 'error');
      } finally {
        setImportData(null);
      }
    })();
  }, [importBoard, importData, queryClient, showToast, t]);

  const inputBackground = colorScheme === 'dark' ? iosSystemColors.white : '#FFFFFF';
  const inputBorder = colorScheme === 'dark' ? 'rgba(60, 60, 67, 0.36)' : 'rgba(60, 60, 67, 0.18)';
  const inputStyle = [styles.input, { backgroundColor: inputBackground, borderColor: inputBorder, color: '#000000' }];

  const credentials = credentialsQuery.data?.credentials;
  const kilterSyncAllowed = credentialsQuery.data?.kilterSyncAllowed === true;
  const isLoading = credentialsQuery.isPending && !credentials;
  const hasLoadError = credentialsQuery.isError && !credentials;

  return (
    <View style={styles.section}>
      <SectionHeader title={t('aurora.title')} />
      {isLoading ? (
        AURORA_BOARDS.map((boardType, boardIndex) => (
          <BoardAccountSkeletonCard
            key={boardType}
            isLast={boardIndex === AURORA_BOARDS.length - 1}
            systemColors={systemColors}
          />
        ))
      ) : hasLoadError ? (
        <BoardAccountsLoadError
          systemColors={systemColors}
          brandColors={brandColors}
          isRetrying={credentialsQuery.isFetching}
          onRetry={() => {
            void credentialsQuery.refetch();
          }}
        />
      ) : (
        AURORA_BOARDS.map((boardType, boardIndex) => {
          const credential = getCredential(credentials ?? [], boardType);
          const unsynced = getUnsyncedCount(unsyncedQuery.data, boardType);
          return (
            <BoardAccountCard
              key={boardType}
              boardType={boardType}
              credential={credential}
              unsyncedCounts={unsynced}
              kilterSyncAllowed={kilterSyncAllowed}
              isLast={boardIndex === AURORA_BOARDS.length - 1}
              isConnectingKilter={connectingKilter}
              isRemoving={deleteCredentialMutation.isPending && deleteCredentialMutation.variables === boardType}
              systemColors={systemColors}
              brandColors={brandColors}
              onConnectKilter={handleConnectKilter}
              onImport={() => handleImportPress(boardType)}
              onLink={() => handleOpenLink(boardType)}
              onRequestData={handleRequestData}
              onUnlink={() => handleUnlink(boardType)}
            />
          );
        })
      )}

      <Modal visible={linkBoard !== null} transparent animationType="fade" onRequestClose={() => setLinkBoard(null)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.modalBackdrop}>
          <View style={[styles.modalCard, { backgroundColor: systemColors.secondaryBackground }]}>
            <Text variant="headline" style={styles.modalTitle}>
              {t('aurora.linkDialog.title', { boardName: linkBoard ? boardDisplayName(linkBoard) : '' })}
            </Text>
            <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.modalCopy}>
              {t('aurora.linkDialog.description', { boardName: linkBoard ? boardDisplayName(linkBoard) : '' })}
            </Text>
            <TextInput
              value={username}
              onChangeText={setUsername}
              placeholder={t('aurora.linkDialog.usernamePlaceholder')}
              placeholderTextColor="rgba(60, 60, 67, 0.6)"
              autoCapitalize="none"
              autoCorrect={false}
              style={inputStyle}
            />
            <TextInput
              value={password}
              onChangeText={setPassword}
              placeholder={t('aurora.linkDialog.passwordPlaceholder')}
              placeholderTextColor="rgba(60, 60, 67, 0.6)"
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              style={inputStyle}
            />
            <Text variant="footnote" color={systemColors.secondaryLabel}>
              {t('aurora.mobile.passwordHelp')}
            </Text>
            <View style={styles.modalActions}>
              <Button title={tCommon('actions.cancel')} variant="text" onPress={() => setLinkBoard(null)} />
              <Button
                title={t('aurora.linkDialog.submit')}
                onPress={handleSubmitLink}
                loading={saveCredentialMutation.isPending}
                disabled={username.trim().length === 0 || password.length === 0 || saveCredentialMutation.isPending}
              />
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <ImportDialog
        visible={importPhase !== null}
        phase={importPhase}
        boardName={importBoard ? boardDisplayName(importBoard) : ''}
        preview={importPreview}
        progress={importProgress}
        progressLabels={stepLabels}
        result={importResult}
        systemColors={systemColors}
        onCancel={resetImport}
        onConfirm={handleImportConfirm}
      />
    </View>
  );
}

type BoardAccountSkeletonCardProps = {
  isLast: boolean;
  systemColors: ReturnType<typeof useTheme>['systemColors'];
};

function BoardAccountSkeletonCard({ isLast, systemColors }: BoardAccountSkeletonCardProps) {
  const skeletonBlockStyle = { backgroundColor: systemColors.fill };

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.card,
        styles.accountCard,
        !isLast && styles.accountCardSpacing,
        { backgroundColor: systemColors.secondaryBackground },
      ]}
    >
      <View style={styles.accountHeader}>
        <View style={styles.skeletonTitleGroup}>
          <View style={[styles.skeletonTitle, skeletonBlockStyle]} />
          <View style={[styles.skeletonSubtitle, skeletonBlockStyle]} />
        </View>
        <View style={[styles.skeletonPill, skeletonBlockStyle]} />
      </View>
      <View style={[styles.skeletonBodyLine, skeletonBlockStyle]} />
      <View style={styles.actionRow}>
        <View style={[styles.skeletonButton, skeletonBlockStyle]} />
        <View style={[styles.skeletonButtonSecondary, skeletonBlockStyle]} />
      </View>
    </View>
  );
}

type BoardAccountsLoadErrorProps = {
  systemColors: ReturnType<typeof useTheme>['systemColors'];
  brandColors: ReturnType<typeof useTheme>['brandColors'];
  isRetrying: boolean;
  onRetry: () => void;
};

function BoardAccountsLoadError({ systemColors, brandColors, isRetrying, onRetry }: BoardAccountsLoadErrorProps) {
  const { t } = useTranslation('settings');
  const { t: tCommon } = useTranslation('common');

  return (
    <View style={[styles.card, styles.loadErrorCard, { backgroundColor: systemColors.secondaryBackground }]}>
      <Icon name="warning" size={20} color={brandColors.warning} />
      <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.loadErrorText}>
        {t('aurora.mobile.loadFailed')}
      </Text>
      <Button
        title={tCommon('actions.retry')}
        variant="outlined"
        size="small"
        loading={isRetrying}
        disabled={isRetrying}
        onPress={onRetry}
      />
    </View>
  );
}

type BoardAccountCardProps = {
  boardType: AuroraBoardName;
  credential: AuroraCredentialStatus | null;
  unsyncedCounts: { ascents: number; climbs: number };
  kilterSyncAllowed: boolean;
  isLast: boolean;
  isConnectingKilter: boolean;
  isRemoving: boolean;
  systemColors: ReturnType<typeof useTheme>['systemColors'];
  brandColors: ReturnType<typeof useTheme>['brandColors'];
  onConnectKilter: () => void;
  onImport: () => void;
  onLink: () => void;
  onRequestData: () => void;
  onUnlink: () => void;
};

function BoardAccountCard({
  boardType,
  credential,
  unsyncedCounts,
  kilterSyncAllowed,
  isLast,
  isConnectingKilter,
  isRemoving,
  systemColors,
  brandColors,
  onConnectKilter,
  onImport,
  onLink,
  onRequestData,
  onUnlink,
}: BoardAccountCardProps) {
  const { t } = useTranslation('settings');
  const boardName = boardDisplayName(boardType);
  const totalUnsynced = unsyncedCounts.ascents + unsyncedCounts.climbs;
  const connectedLabel = credential?.auroraUsername
    ? t('aurora.mobile.connectedAs', { name: credential.auroraUsername })
    : t('aurora.mobile.connected');

  return (
    <View
      style={[
        styles.card,
        styles.accountCard,
        !isLast && styles.accountCardSpacing,
        { backgroundColor: systemColors.secondaryBackground },
      ]}
    >
      <View style={styles.accountHeader}>
        <View>
          <Text variant="headline">{boardName}</Text>
          <Text variant="subheadline" color={systemColors.secondaryLabel}>
            {credential ? connectedLabel : t('aurora.mobile.notConnected')}
          </Text>
        </View>
        <View
          style={[styles.statusPill, { backgroundColor: credential ? brandColors.primaryFill : systemColors.fill }]}
        >
          <Text variant="caption1" color={credential ? brandColors.onPrimary : systemColors.secondaryLabel}>
            {credential ? t('aurora.status.connected') : t('aurora.mobile.notConnected')}
          </Text>
        </View>
      </View>

      {credential ? (
        <>
          {credential.syncError ? (
            <Text variant="footnote" color={brandColors.error} style={styles.accountCopy}>
              {t('aurora.status.error')}
            </Text>
          ) : null}
          {totalUnsynced > 0 ? (
            <View style={[styles.warningBlock, { backgroundColor: systemColors.tertiaryBackground }]}>
              <Icon name="warning" size={18} color={brandColors.warning} />
              <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.warningText}>
                {t('aurora.unsynced.title', { count: totalUnsynced })}
              </Text>
            </View>
          ) : null}
          <View style={styles.actionRow}>
            <Button title={t('aurora.card.import')} icon="upload" variant="outlined" size="small" onPress={onImport} />
            <Button
              title={t('aurora.card.unlink')}
              icon="delete"
              variant="text"
              size="small"
              tintColor={brandColors.error}
              loading={isRemoving}
              disabled={isRemoving}
              onPress={onUnlink}
            />
          </View>
        </>
      ) : boardType === 'kilter' && kilterSyncAllowed ? (
        <>
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.accountCopy}>
            {t('aurora.card.kilterConnectCopy')}
          </Text>
          <View style={styles.actionRow}>
            <Button
              title={t('aurora.card.kilterConnectButton')}
              icon="open.external"
              size="small"
              loading={isConnectingKilter}
              disabled={isConnectingKilter}
              onPress={onConnectKilter}
            />
            <Button title={t('aurora.card.import')} icon="upload" variant="outlined" size="small" onPress={onImport} />
          </View>
        </>
      ) : boardType === 'kilter' ? (
        <>
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.accountCopy}>
            {t('aurora.card.kilterShutdown')}
          </Text>
          <View style={styles.actionRow}>
            <Button title={t('aurora.card.import')} icon="upload" variant="outlined" size="small" onPress={onImport} />
            <Button
              title={t('aurora.card.requestData')}
              icon="open.external"
              variant="text"
              size="small"
              onPress={onRequestData}
            />
          </View>
        </>
      ) : (
        <>
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.accountCopy}>
            {t('aurora.card.notConnected', { boardName })}
          </Text>
          <View style={styles.actionRow}>
            <Button title={t('aurora.card.link')} icon="link" size="small" onPress={onLink} />
            <Button title={t('aurora.card.import')} icon="upload" variant="outlined" size="small" onPress={onImport} />
          </View>
        </>
      )}
    </View>
  );
}

type ImportDialogProps = {
  visible: boolean;
  phase: ImportPhase | null;
  boardName: string;
  preview: AuroraExportPreview | null;
  progress: ImportProgress | null;
  progressLabels: Record<ImportStep, string>;
  result: ImportResult | null;
  systemColors: ReturnType<typeof useTheme>['systemColors'];
  onCancel: () => void;
  onConfirm: () => void;
};

function ImportDialog({
  visible,
  phase,
  boardName,
  preview,
  progress,
  progressLabels,
  result,
  systemColors,
  onCancel,
  onConfirm,
}: ImportDialogProps) {
  const { t } = useTranslation('settings');
  const { t: tCommon } = useTranslation('common');
  let title = t('aurora.import.dialog.errorTitle');
  if (phase === 'preview') {
    title = t('aurora.import.dialog.previewTitle');
  } else if (phase === 'importing') {
    title = t('aurora.import.dialog.importingTitle');
  } else if (phase === 'complete') {
    title = t('aurora.import.dialog.completeTitle');
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={phase === 'importing' ? undefined : onCancel}
    >
      <View style={styles.modalBackdrop}>
        <View style={[styles.modalCard, styles.importModalCard, { backgroundColor: systemColors.secondaryBackground }]}>
          <Text variant="headline" style={styles.modalTitle}>
            {title}
          </Text>

          {phase === 'preview' && preview ? (
            <>
              <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.modalCopy}>
                {t('aurora.mobile.importPreviewIntro', { username: preview.username, boardName })}
              </Text>
              <View style={[styles.summaryBox, { backgroundColor: systemColors.tertiaryBackground }]}>
                <SummaryLine label={t('aurora.import.dialog.draftClimbs', { count: preview.climbs })} />
                <SummaryLine label={t('aurora.import.dialog.ascents', { count: preview.ascents })} />
                <SummaryLine label={t('aurora.import.dialog.attempts', { count: preview.attempts })} />
                <SummaryLine label={t('aurora.import.dialog.circuits', { count: preview.circuits })} />
              </View>
              <Text variant="footnote" color={systemColors.secondaryLabel}>
                {t('aurora.import.dialog.previewNote')}
              </Text>
              <View style={styles.modalActions}>
                <Button title={tCommon('actions.cancel')} variant="text" onPress={onCancel} />
                <Button title={t('aurora.import.dialog.confirm')} icon="upload" onPress={onConfirm} />
              </View>
            </>
          ) : null}

          {phase === 'importing' ? (
            <View style={styles.importProgressBlock}>
              <ActivityIndicator />
              <Text variant="subheadline" color={systemColors.secondaryLabel}>
                {progress ? progressLabels[progress.step] : progressLabels.resolving}
                {progress?.current != null && progress.total != null ? ` (${progress.current}/${progress.total})` : ''}
              </Text>
            </View>
          ) : null}

          {phase === 'complete' && result ? (
            <>
              <ScrollView style={styles.resultScroll}>
                <ImportResultSummary result={result} />
              </ScrollView>
              <View style={styles.modalActions}>
                <Button title={tCommon('actions.done')} onPress={onCancel} />
              </View>
            </>
          ) : null}

          {phase === 'error' ? (
            <>
              <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.modalCopy}>
                {t('aurora.mobile.importInterrupted')}
              </Text>
              <View style={styles.modalActions}>
                <Button title={tCommon('actions.close')} onPress={onCancel} />
              </View>
            </>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

function SummaryLine({ label }: { label: string }) {
  const { systemColors } = useTheme();
  return (
    <View style={styles.summaryLine}>
      <Icon name="tick.outline" size={16} color={systemColors.secondaryLabel} />
      <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.summaryLineText}>
        {label}
      </Text>
    </View>
  );
}

function ImportResultSummary({ result }: { result: ImportResult }) {
  const { t } = useTranslation('settings');
  const { systemColors } = useTheme();

  return (
    <View style={styles.resultList}>
      <ResultLine
        title={t('aurora.import.results.draftClimbs')}
        summary={t('aurora.import.results.draftClimbsSummary', result.climbs)}
      />
      <ResultLine
        title={t('aurora.import.results.ascents')}
        summary={t('aurora.import.results.ascentsSummary', result.ascents)}
      />
      <ResultLine
        title={t('aurora.import.results.attempts')}
        summary={t('aurora.import.results.attemptsSummary', result.attempts)}
      />
      <ResultLine
        title={t('aurora.import.results.circuits')}
        summary={t('aurora.import.results.circuitsSummary', result.circuits)}
      />
      {result.partialError ? (
        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.resultWarning}>
          {t('aurora.import.results.partialBody')}
        </Text>
      ) : null}
      <UnresolvedList
        title={t('aurora.import.results.unresolvedAscentsTitle', { count: result.unresolvedAscentClimbs.length })}
        names={result.unresolvedAscentClimbs}
      />
      <UnresolvedList
        title={t('aurora.import.results.unresolvedAttemptsTitle', { count: result.unresolvedAttemptClimbs.length })}
        names={result.unresolvedAttemptClimbs}
      />
      <UnresolvedList
        title={t('aurora.import.results.unresolvedCircuitsTitle', { count: result.unresolvedCircuitClimbs.length })}
        names={result.unresolvedCircuitClimbs}
      />
    </View>
  );
}

function ResultLine({ title, summary }: { title: string; summary: string }) {
  const { systemColors } = useTheme();
  return (
    <View style={styles.resultLine}>
      <Text variant="subheadline">{title}</Text>
      <Text variant="footnote" color={systemColors.secondaryLabel}>
        {summary}
      </Text>
    </View>
  );
}

function UnresolvedList({ title, names }: { title: string; names: string[] }) {
  const { t } = useTranslation('settings');
  const { systemColors } = useTheme();
  if (names.length === 0) return null;

  const shown = names.slice(0, IMPORT_RESULT_LIMIT);
  const remaining = names.length - shown.length;

  return (
    <View style={styles.unresolvedBlock}>
      <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.resultWarning}>
        {title}
      </Text>
      {shown.map((name) => (
        <Text key={name} variant="caption1" color={systemColors.secondaryLabel}>
          {name}
        </Text>
      ))}
      {remaining > 0 ? (
        <Text variant="caption1" color={systemColors.secondaryLabel}>
          {t('aurora.import.results.unresolvedMore', { count: remaining })}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    width: '100%',
    marginBottom: spacing[6],
  },
  card: {
    borderRadius: borderRadius.lg,
    marginHorizontal: spacing[4],
  },
  accountCard: {
    padding: spacing[4],
  },
  accountCardSpacing: {
    marginBottom: spacing[3],
  },
  accountHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing[3],
  },
  statusPill: {
    borderRadius: borderRadius.full,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[1],
  },
  accountCopy: {
    marginTop: spacing[3],
  },
  warningBlock: {
    marginTop: spacing[3],
    borderRadius: borderRadius.md,
    padding: spacing[3],
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  warningText: {
    flex: 1,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing[2],
    marginTop: spacing[4],
  },
  skeletonTitleGroup: {
    flex: 1,
    minWidth: 0,
    gap: spacing[2],
  },
  skeletonTitle: {
    width: 92,
    height: 20,
    borderRadius: borderRadius.full,
    opacity: 0.55,
  },
  skeletonSubtitle: {
    width: '62%',
    height: 14,
    borderRadius: borderRadius.full,
    opacity: 0.4,
  },
  skeletonPill: {
    width: 86,
    height: 24,
    borderRadius: borderRadius.full,
    opacity: 0.45,
  },
  skeletonBodyLine: {
    width: '84%',
    height: 14,
    borderRadius: borderRadius.full,
    opacity: 0.35,
    marginTop: spacing[4],
  },
  skeletonButton: {
    width: 72,
    height: 32,
    borderRadius: borderRadius.full,
    opacity: 0.45,
  },
  skeletonButtonSecondary: {
    width: 86,
    height: 32,
    borderRadius: borderRadius.full,
    opacity: 0.32,
  },
  loadErrorCard: {
    padding: spacing[4],
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
  },
  loadErrorText: {
    flex: 1,
    lineHeight: 18,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing[4],
  },
  modalCard: {
    width: '100%',
    maxWidth: 420,
    borderRadius: borderRadius.lg,
    padding: spacing[4],
    gap: spacing[3],
  },
  importModalCard: {
    maxHeight: '86%',
  },
  modalTitle: {
    fontWeight: '700',
  },
  modalCopy: {
    lineHeight: 20,
  },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: borderRadius.md,
    minHeight: 48,
    paddingHorizontal: spacing[3],
    fontSize: 16,
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing[2],
    marginTop: spacing[2],
  },
  summaryBox: {
    borderRadius: borderRadius.md,
    padding: spacing[3],
    gap: spacing[2],
  },
  summaryLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  summaryLineText: {
    flex: 1,
  },
  importProgressBlock: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing[8],
    gap: spacing[3],
  },
  resultScroll: {
    maxHeight: 420,
  },
  resultList: {
    gap: spacing[3],
  },
  resultLine: {
    gap: spacing[1],
  },
  resultWarning: {
    lineHeight: 18,
  },
  unresolvedBlock: {
    gap: spacing[1],
  },
});
