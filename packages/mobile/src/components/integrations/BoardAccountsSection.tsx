import { memo, useCallback, useMemo, useState } from 'react';
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
import * as Clipboard from 'expo-clipboard';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { DUPLICATE_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR } from '@boardsesh/shared-schema/sync-error-codes';
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
import { OfflineState } from '../OfflineState';
import { SectionHeader } from '../SectionHeader';
import { Text } from '../Text';
import { useOfflineQueryState } from '../../hooks/use-offline-query-state';
import { useTheme } from '../../providers/theme-provider';
import { useToast } from '../../providers/toast-provider';
import { useConfirm } from '../../providers/dialog-provider';
import { useFeatureFlag } from '../../providers/feature-flags-provider';
import { borderRadius, spacing } from '../../theme/tokens';
import { iosSystemColors } from '../../theme/ios-colors';
import {
  BoardAccountError,
  deleteAuroraCredential,
  getAuroraCredentials,
  getAuroraUnsyncedCounts,
  saveAuroraCredential,
  saveKilterCredentialViaPassword,
  streamAuroraImport,
  streamMoonBoardImport,
  type AuroraCredentialStatus,
  type MoonBoardImportProgressEvent,
  type MoonBoardImportResult,
  type StrippedMoonBoardExportData,
  type UnsyncedCounts,
} from '../../lib/aurora-credentials';

type ImportPhase = 'preview' | 'importing' | 'complete' | 'error';
type ImportStep = 'climbs' | 'resolving' | 'dedup' | 'ascents' | 'attempts' | 'circuits';
type MoonBoardExportPreview = {
  username?: string;
  rows: number;
  sends: number;
  flashes: number;
  attempts: number;
  projects: number;
  fails: number;
  angle: number;
};

// Kilter renders two cards: `kilterAurora` for the legacy Aurora-built app (JSON
// import + data request) and `kilterNew` for the new Kilter Grips account, which
// links via username/password (ROPC). Every other board is a single `aurora` card.
type BoardAccountCardVariant = 'aurora' | 'kilterAurora' | 'kilterNew';

type ImportProgress = {
  step: ImportStep;
  current?: number;
  total?: number;
};

type MoonBoardProgress = {
  step: string;
  message?: string;
  current?: number;
  total?: number;
};

type ParsedMoonBoardExport = {
  data: StrippedMoonBoardExportData;
  preview: MoonBoardExportPreview;
};

type MoonBoardSharedSchemaModule = {
  parseMoonBoardExportCsv?: (csv: string) => unknown | Promise<unknown>;
};

const MAX_IMPORT_SIZE_BYTES = 200 * 1024 * 1024;
const IMPORT_RESULT_LIMIT = 8;
const AURORA_CREDENTIALS_QUERY_KEY = ['auroraCredentials'] as const;
const AURORA_UNSYNCED_QUERY_KEY = ['auroraCredentials', 'unsynced'] as const;

// MoonBoard isn't an Aurora board, so it has no credential/sync flow.
const MOONBOARD_SUPPORT_EMAIL = 'moonboardsupport@moonclimbing.com';

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

function readNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function readString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return undefined;
}

function normalizeMoonBoardParsedExport(parsed: unknown): ParsedMoonBoardExport {
  if (!isRecord(parsed) || !('data' in parsed) || !isRecord(parsed.preview)) {
    throw new Error('moonboard_parser_invalid_result');
  }

  const preview = parsed.preview;
  return {
    data: parsed.data,
    preview: {
      username: readString(preview, ['username', 'userName']),
      rows: readNumber(preview, ['rows', 'rowCount', 'entries', 'totalRows']) ?? 0,
      sends: readNumber(preview, ['sends', 'ascents', 'sendCount']) ?? 0,
      flashes: readNumber(preview, ['flashes', 'flashCount']) ?? 0,
      attempts: readNumber(preview, ['attempts', 'attemptCount']) ?? 0,
      projects: readNumber(preview, ['projects', 'projectCount']) ?? 0,
      fails: readNumber(preview, ['fails', 'failures', 'failCount']) ?? 0,
      angle: readNumber(preview, ['angle', 'boardAngle']) ?? 40,
    },
  };
}

async function parseMoonBoardCsvForImport(csv: string): Promise<ParsedMoonBoardExport> {
  const sharedSchema = (await import('@boardsesh/shared-schema')) as unknown as MoonBoardSharedSchemaModule;
  if (typeof sharedSchema.parseMoonBoardExportCsv !== 'function') {
    throw new Error('moonboard_parser_unavailable');
  }
  return normalizeMoonBoardParsedExport(await sharedSchema.parseMoonBoardExportCsv(csv));
}

// The i18n keys must stay literal in each builder (the linter hard-fails on
// `t(variable)`), so only the mailto string assembly is shared here. The body is
// optional: the MoonBoard GDPR letter is too long to survive URL-encoding into a
// mailto: URI on many clients, so it rides the clipboard instead and only the
// subject goes in the URI.
function dataRequestMailto(recipient: string, subject: string, body?: string): string {
  const query = body
    ? `subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
    : `subject=${encodeURIComponent(subject)}`;
  return `mailto:${recipient}?${query}`;
}

function buildKilterDataRequestMailto(t: TFunction<'settings'>): string {
  const name = t('aurora.kilterEmail.namePlaceholder');
  const email = t('aurora.kilterEmail.emailPlaceholder');
  const subject = t('aurora.kilterEmail.subject');
  const body = t('aurora.kilterEmail.body', { name, email });
  return dataRequestMailto('peter@auroraclimbing.com', subject, body);
}

function buildMoonBoardDataRequestMailto(t: TFunction<'settings'>): string {
  const subject = t('aurora.moonboard.email.subject');
  return dataRequestMailto(MOONBOARD_SUPPORT_EMAIL, subject);
}

function totalImported(result: ImportResult): number {
  return result.climbs.imported + result.ascents.imported + result.attempts.imported + result.circuits.imported;
}

function totalMoonBoardImported(result: MoonBoardImportResult): number {
  return result.ascents.imported + result.attempts.imported;
}

function moonBoardUnresolvedClimbs(result: MoonBoardImportResult): string[] {
  return [
    ...new Set([
      ...result.unresolvedClimbs,
      ...(result.unresolvedAscentClimbs ?? []),
      ...(result.unresolvedAttemptClimbs ?? []),
    ]),
  ].sort();
}

function getMoonBoardProgressLabel(t: TFunction<'settings'>, progress: MoonBoardProgress | null): string {
  if (!progress) return t('aurora.moonboard.csvImport.steps.resolving');
  switch (progress.step) {
    case 'ascents':
      return t('aurora.moonboard.csvImport.steps.ascents');
    case 'attempts':
      return t('aurora.moonboard.csvImport.steps.attempts');
    case 'dedup':
      return t('aurora.moonboard.csvImport.steps.dedup');
    case 'resolving':
      return t('aurora.moonboard.csvImport.steps.resolving');
    case 'importing':
      return t('aurora.moonboard.csvImport.steps.importing');
    case 'recomputing':
      return t('aurora.moonboard.csvImport.steps.recomputing');
    default:
      return t('aurora.moonboard.csvImport.steps.importing');
  }
}

function getMoonBoardImportErrorMessage(t: TFunction<'settings'>, error: unknown): string {
  const errorCode = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (errorCode === 'moonboard_import_interrupted') {
    return t('aurora.moonboard.csvImport.interrupted');
  }
  return t('aurora.moonboard.csvImport.failed');
}

// Kilter links via the password grant (`/api/board-credentials/kilter/password`);
// every other board posts username/password to the Aurora endpoint.
async function saveBoardCredential(input: { boardType: AuroraBoardName; username: string; password: string }) {
  if (input.boardType === 'kilter') {
    await saveKilterCredentialViaPassword({ username: input.username, password: input.password });
    return null;
  }
  return saveAuroraCredential(input);
}

function errorMessageFor(error: unknown, t: TFunction<'settings'>): string {
  if (error instanceof BoardAccountError) {
    switch (error.code) {
      case 'account_already_linked':
        return t('aurora.linkDialog.accountAlreadyLinked');
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

  const kilterOauthLinkingEnabled = useFeatureFlag('kilter-oauth-linking') === true;

  const [linkBoard, setLinkBoard] = useState<AuroraBoardName | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [importBoard, setImportBoard] = useState<AuroraBoardName | null>(null);
  const [importPreview, setImportPreview] = useState<AuroraExportPreview | null>(null);
  const [importData, setImportData] = useState<StrippedAuroraExportData | null>(null);
  const [importPhase, setImportPhase] = useState<ImportPhase | null>(null);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);

  const saveCredentialMutation = useMutation({
    mutationFn: saveBoardCredential,
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
  const hasKilterCredential = getCredential(credentials ?? [], 'kilter') !== null;
  // Show the new Kilter card when the `kilter-oauth-linking` flag is on, or whenever a
  // Kilter account is already linked (so it stays manageable if the flag flips off).
  const showKilterNew = kilterOauthLinkingEnabled || hasKilterCredential;
  const isLoading = credentialsQuery.isPending && !credentials;
  const hasLoadError = credentialsQuery.isError && !credentials;
  // With nothing cached and nothing reachable, `networkMode: 'offlineFirst'`
  // PAUSES this query: `isPending` stays true, so the skeletons above would sit
  // there forever pretending a fetch was on its way. Checked ahead of both
  // branches, and it names which side is down rather than saying "no signal" to
  // someone whose signal is fine.
  const offlineQuery = useOfflineQueryState({
    status: credentialsQuery.status,
    fetchStatus: credentialsQuery.fetchStatus,
    data: credentials,
  });
  // Only the three CONNECTIVITY reasons take the placard. A request that reached
  // a reachable server and failed anyway keeps the compact load-error card below,
  // whose Retry shows its own in-flight spinner — routing that case here too
  // would leave every ordinary failure without one.
  const showOfflinePlacard = offlineQuery.isBlocked && offlineQuery.reason !== null && offlineQuery.reason !== 'error';

  const cardConfigs = AURORA_BOARDS.flatMap<{
    key: string;
    boardType: AuroraBoardName;
    variant: BoardAccountCardVariant;
  }>((boardType) => {
    if (boardType !== 'kilter') return [{ key: boardType, boardType, variant: 'aurora' }];
    const kilterCards: { key: string; boardType: AuroraBoardName; variant: BoardAccountCardVariant }[] = [
      { key: 'kilter-aurora', boardType: 'kilter', variant: 'kilterAurora' },
    ];
    if (showKilterNew) kilterCards.push({ key: 'kilter-new', boardType: 'kilter', variant: 'kilterNew' });
    return kilterCards;
  });

  return (
    <View style={styles.section}>
      <SectionHeader title={t('aurora.title')} />
      <MoonBoardAccountCard />
      {showOfflinePlacard && offlineQuery.reason ? (
        <OfflineState reason={offlineQuery.reason} />
      ) : isLoading ? (
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
        cardConfigs.map((cardConfig, cardIndex) => {
          // The legacy "Kilter (Aurora)" card never owns the linked-account state —
          // that belongs to the new card.
          const credential =
            cardConfig.variant === 'kilterAurora' ? null : getCredential(credentials ?? [], cardConfig.boardType);
          const unsynced = getUnsyncedCount(unsyncedQuery.data, cardConfig.boardType);
          return (
            <BoardAccountCard
              key={cardConfig.key}
              boardType={cardConfig.boardType}
              variant={cardConfig.variant}
              credential={credential}
              unsyncedCounts={unsynced}
              isLast={cardIndex === cardConfigs.length - 1}
              isRemoving={
                deleteCredentialMutation.isPending && deleteCredentialMutation.variables === cardConfig.boardType
              }
              systemColors={systemColors}
              brandColors={brandColors}
              onImport={() => handleImportPress(cardConfig.boardType)}
              onLink={() => handleOpenLink(cardConfig.boardType)}
              onRequestData={handleRequestData}
              onUnlink={() => handleUnlink(cardConfig.boardType)}
            />
          );
        })
      )}

      <Modal visible={linkBoard !== null} transparent animationType="fade" onRequestClose={() => setLinkBoard(null)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.modalBackdrop}>
          <View style={[styles.modalCard, { backgroundColor: systemColors.secondaryBackground }]}>
            <Text variant="headline" style={styles.modalTitle}>
              {linkBoard === 'kilter'
                ? t('aurora.kilterLinkDialog.title')
                : t('aurora.linkDialog.title', { boardName: linkBoard ? boardDisplayName(linkBoard) : '' })}
            </Text>
            <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.modalCopy}>
              {linkBoard === 'kilter'
                ? t('aurora.kilterLinkDialog.description')
                : t('aurora.linkDialog.description', { boardName: linkBoard ? boardDisplayName(linkBoard) : '' })}
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
              {linkBoard === 'kilter' ? t('aurora.kilterLinkDialog.passwordHelp') : t('aurora.mobile.passwordHelp')}
            </Text>
            <View style={styles.modalActions}>
              <Button
                title={tCommon('actions.cancel')}
                variant="text"
                role="cancel"
                onPress={() => setLinkBoard(null)}
              />
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

// Standalone (no props), so memo skips re-renders when the query/import-state
// heavy BoardAccountsSection parent re-renders.
const MoonBoardAccountCard = memo(function MoonBoardAccountCard() {
  const { t } = useTranslation('settings');
  const { systemColors } = useTheme();
  const { showToast } = useToast();
  const confirm = useConfirm();
  const [importPreview, setImportPreview] = useState<MoonBoardExportPreview | null>(null);
  const [importData, setImportData] = useState<StrippedMoonBoardExportData | null>(null);
  const [importPhase, setImportPhase] = useState<ImportPhase | null>(null);
  const [importProgress, setImportProgress] = useState<MoonBoardProgress | null>(null);
  const [importResult, setImportResult] = useState<MoonBoardImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const resetImport = useCallback(() => {
    if (importPhase === 'importing') return;
    setImportPreview(null);
    setImportData(null);
    setImportPhase(null);
    setImportProgress(null);
    setImportResult(null);
    setImportError(null);
  }, [importPhase]);

  const handleRequestData = useCallback(() => {
    // The GDPR letter is too long to encode into the mailto: body reliably, so
    // copy it to the clipboard and open a draft with just the subject.
    const openRequest = async () => {
      try {
        await Clipboard.setStringAsync(t('aurora.moonboard.email.body'));
      } catch {
        showToast(t('aurora.mobile.requestDataCopyFailed'), 'error');
        return;
      }
      // Surface the paste instruction in a dialog *before* opening the mail app.
      // A toast would be hidden by the app switch, leaving the user staring at a
      // blank draft (the mailto: has no body) with no prompt to paste.
      const shouldOpenEmail = await confirm({
        title: t('aurora.moonboard.requestDataDialog.title'),
        message: t('aurora.moonboard.requestDataDialog.message'),
        confirmLabel: t('aurora.moonboard.requestDataDialog.confirm'),
        cancelLabel: t('aurora.moonboard.requestDataDialog.cancel'),
      });
      // The letter is on the clipboard either way (the dialog said so), but if
      // the user asked to open their email and no client is installed, say so.
      if (shouldOpenEmail) {
        void Linking.openURL(buildMoonBoardDataRequestMailto(t)).catch(() => {
          showToast(t('aurora.mobile.requestDataFailed'), 'error');
        });
      }
    };
    void openRequest();
  }, [confirm, showToast, t]);

  const handleImportPress = useCallback(() => {
    void (async () => {
      try {
        const DocumentPicker = await import('expo-document-picker');
        const document = await DocumentPicker.getDocumentAsync({
          type: ['text/csv', 'text/plain', 'application/vnd.ms-excel'],
          copyToCacheDirectory: true,
        });
        if (document.canceled) return;

        const asset = document.assets[0];
        if (!asset) return;
        if (asset.size != null && asset.size > MAX_IMPORT_SIZE_BYTES) {
          showToast(t('aurora.import.tooLarge'), 'error');
          return;
        }

        const csv = await new File(asset.uri).text();
        const parsed = await parseMoonBoardCsvForImport(csv);
        setImportData(parsed.data);
        setImportPreview(parsed.preview);
        setImportPhase('preview');
        setImportProgress(null);
        setImportResult(null);
        setImportError(null);
      } catch (error) {
        const message =
          error instanceof Error && error.message === 'moonboard_parser_unavailable'
            ? t('aurora.moonboard.csvImport.parserUnavailable')
            : t('aurora.moonboard.csvImport.parseError');
        showToast(message, 'error');
        setImportPreview(null);
        setImportData(null);
        setImportPhase(null);
      }
    })();
  }, [showToast, t]);

  const handleImportConfirm = useCallback(() => {
    if (!importData) return;

    setImportPhase('importing');
    setImportProgress(null);
    setImportPreview(null);
    setImportResult(null);
    setImportError(null);

    void (async () => {
      try {
        await streamMoonBoardImport(importData, (event: MoonBoardImportProgressEvent) => {
          if (event.type === 'progress') {
            setImportProgress({
              step: event.step,
              message: 'message' in event ? event.message : undefined,
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
                ? t('aurora.moonboard.csvImport.partialWarning')
                : t('aurora.moonboard.csvImport.successCount', { count: totalMoonBoardImported(event.results) }),
              event.results.partialError ? 'warning' : 'success',
            );
            return;
          }

          const importErrorMessage = getMoonBoardImportErrorMessage(t, event.error);
          setImportError(importErrorMessage);
          setImportPhase('error');
          showToast(importErrorMessage, 'error');
        });
      } catch (error) {
        const importErrorMessage = getMoonBoardImportErrorMessage(t, error);
        setImportError(importErrorMessage);
        setImportPhase('error');
        showToast(importErrorMessage, 'error');
      } finally {
        setImportData(null);
      }
    })();
  }, [importData, showToast, t]);

  return (
    <View
      style={[
        styles.card,
        styles.accountCard,
        styles.accountCardSpacing,
        { backgroundColor: systemColors.secondaryBackground },
      ]}
    >
      <View style={styles.accountHeader}>
        <View>
          <Text variant="headline">{t('aurora.moonboard.title')}</Text>
        </View>
      </View>
      <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.accountCopy}>
        {t('aurora.moonboard.copy')}
      </Text>
      <View style={styles.actionRow}>
        <Button
          title={t('aurora.moonboard.import')}
          icon="upload"
          variant="outlined"
          size="small"
          loading={importPhase === 'importing'}
          disabled={importPhase === 'importing'}
          onPress={handleImportPress}
        />
        <Button
          title={t('aurora.moonboard.requestData')}
          icon="open.external"
          variant="text"
          size="small"
          onPress={handleRequestData}
        />
      </View>

      <MoonBoardImportDialog
        visible={importPhase !== null}
        phase={importPhase}
        preview={importPreview}
        progress={importProgress}
        result={importResult}
        error={importError}
        systemColors={systemColors}
        onCancel={resetImport}
        onConfirm={handleImportConfirm}
      />
    </View>
  );
});

type MoonBoardImportDialogProps = {
  visible: boolean;
  phase: ImportPhase | null;
  preview: MoonBoardExportPreview | null;
  progress: MoonBoardProgress | null;
  result: MoonBoardImportResult | null;
  error: string | null;
  systemColors: ReturnType<typeof useTheme>['systemColors'];
  onCancel: () => void;
  onConfirm: () => void;
};

function MoonBoardImportDialog({
  visible,
  phase,
  preview,
  progress,
  result,
  error,
  systemColors,
  onCancel,
  onConfirm,
}: MoonBoardImportDialogProps) {
  const { t } = useTranslation('settings');
  const { t: tCommon } = useTranslation('common');
  let title = t('aurora.moonboard.importDialog.errorTitle');
  if (phase === 'preview') {
    title = t('aurora.moonboard.importDialog.previewTitle');
  } else if (phase === 'importing') {
    title = t('aurora.moonboard.importDialog.importingTitle');
  } else if (phase === 'complete') {
    title = t('aurora.moonboard.importDialog.completeTitle');
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
                {preview.username
                  ? t('aurora.moonboard.importDialog.previewIntroWithUser', { username: preview.username })
                  : t('aurora.moonboard.importDialog.previewIntro')}
              </Text>
              <View style={[styles.summaryBox, { backgroundColor: systemColors.tertiaryBackground }]}>
                <SummaryLine label={t('aurora.moonboard.importDialog.rows', { count: preview.rows })} />
                <SummaryLine label={t('aurora.moonboard.importDialog.sends', { count: preview.sends })} />
                <SummaryLine label={t('aurora.moonboard.importDialog.flashes', { count: preview.flashes })} />
                <SummaryLine label={t('aurora.moonboard.importDialog.attempts', { count: preview.attempts })} />
                {preview.projects > 0 ? (
                  <SummaryLine label={t('aurora.moonboard.importDialog.projects', { count: preview.projects })} />
                ) : null}
                {preview.fails > 0 ? (
                  <SummaryLine label={t('aurora.moonboard.importDialog.fails', { count: preview.fails })} />
                ) : null}
                <SummaryLine label={t('aurora.moonboard.importDialog.angleNote', { angle: preview.angle })} />
              </View>
              <Text variant="footnote" color={systemColors.secondaryLabel}>
                {t('aurora.moonboard.importDialog.previewNote')}
              </Text>
              <View style={styles.modalActions}>
                <Button title={tCommon('actions.cancel')} variant="text" role="cancel" onPress={onCancel} />
                <Button title={t('aurora.import.dialog.confirm')} icon="upload" onPress={onConfirm} />
              </View>
            </>
          ) : null}

          {phase === 'importing' ? (
            <View style={styles.importProgressBlock}>
              <ActivityIndicator />
              <Text variant="subheadline" color={systemColors.secondaryLabel}>
                {getMoonBoardProgressLabel(t, progress)}
                {progress?.current != null && progress.total != null ? ` (${progress.current}/${progress.total})` : ''}
              </Text>
            </View>
          ) : null}

          {phase === 'complete' && result ? (
            <>
              <ScrollView style={styles.resultScroll}>
                <MoonBoardImportResultSummary result={result} />
              </ScrollView>
              <View style={styles.modalActions}>
                <Button title={tCommon('actions.done')} onPress={onCancel} />
              </View>
            </>
          ) : null}

          {phase === 'error' ? (
            <>
              <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.modalCopy}>
                {error ?? t('aurora.moonboard.csvImport.interrupted')}
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

function MoonBoardImportResultSummary({ result }: { result: MoonBoardImportResult }) {
  const { t } = useTranslation('settings');
  const { systemColors } = useTheme();
  const unresolvedNames = moonBoardUnresolvedClimbs(result);

  return (
    <View style={styles.resultList}>
      <ResultLine
        title={t('aurora.moonboard.importResults.ascents')}
        summary={t('aurora.moonboard.importResults.ascentsSummary', result.ascents)}
      />
      <ResultLine
        title={t('aurora.moonboard.importResults.attempts')}
        summary={t('aurora.moonboard.importResults.attemptsSummary', result.attempts)}
      />
      {result.partialError ? (
        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.resultWarning}>
          {t('aurora.moonboard.importResults.partialBody')}
        </Text>
      ) : null}
      <UnresolvedList
        title={t('aurora.moonboard.importResults.unresolvedTitle', { count: unresolvedNames.length })}
        names={unresolvedNames}
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
  variant: BoardAccountCardVariant;
  credential: AuroraCredentialStatus | null;
  unsyncedCounts: { ascents: number; climbs: number };
  isLast: boolean;
  isRemoving: boolean;
  systemColors: ReturnType<typeof useTheme>['systemColors'];
  brandColors: ReturnType<typeof useTheme>['brandColors'];
  onImport: () => void;
  onLink: () => void;
  onRequestData: () => void;
  onUnlink: () => void;
};

function BoardAccountCard({
  boardType,
  variant,
  credential,
  unsyncedCounts,
  isLast,
  isRemoving,
  systemColors,
  brandColors,
  onImport,
  onLink,
  onRequestData,
  onUnlink,
}: BoardAccountCardProps) {
  const { t } = useTranslation('settings');
  const boardName = boardDisplayName(boardType);
  const cardTitle =
    variant === 'kilterAurora'
      ? t('aurora.card.kilterAuroraTitle')
      : variant === 'kilterNew'
        ? t('aurora.card.kilterNewTitle')
        : boardName;
  const totalUnsynced = unsyncedCounts.ascents + unsyncedCounts.climbs;
  const isExpired = credential?.syncStatus === 'expired';
  // The sync daemons write a machine-readable code here for conditions the
  // client is expected to explain in the viewer's language (#3526). Everything
  // else in `sync_error` is still free text from an older path — those keep the
  // generic error pill rather than being swallowed.
  const hasDuplicateAccountCircuits = credential?.syncError === DUPLICATE_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR;
  // A warning, not a failure: the credential is active and syncing, only the
  // playlist mirror is paused. Red text here would tell a healthy account it is
  // broken, with nothing to act on.
  const hasSyncFailure = Boolean(credential?.syncError) && !hasDuplicateAccountCircuits;
  const connectedLabel = credential?.auroraUsername
    ? t('aurora.mobile.connectedAs', { name: credential.auroraUsername })
    : t('aurora.mobile.connected');
  // The legacy Kilter (Aurora) card is a data-import surface, not an account you
  // connect — so it drops the connection subtitle + status pill.
  const showStatus = variant !== 'kilterAurora';

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
          <Text variant="headline">{cardTitle}</Text>
          {showStatus ? (
            <Text variant="subheadline" color={systemColors.secondaryLabel}>
              {credential ? connectedLabel : t('aurora.mobile.notConnected')}
            </Text>
          ) : null}
        </View>
        {showStatus ? (
          <View
            style={[styles.statusPill, { backgroundColor: credential ? brandColors.primaryFill : systemColors.fill }]}
          >
            <Text variant="caption1" color={credential ? brandColors.onPrimary : systemColors.secondaryLabel}>
              {credential ? t('aurora.status.connected') : t('aurora.mobile.notConnected')}
            </Text>
          </View>
        ) : null}
      </View>

      {credential ? (
        <>
          {isExpired ? (
            <Text variant="footnote" color={brandColors.error} style={styles.accountCopy}>
              {t('aurora.status.expired')}
            </Text>
          ) : hasSyncFailure ? (
            <Text variant="footnote" color={brandColors.error} style={styles.accountCopy}>
              {t('aurora.status.error')}
            </Text>
          ) : null}
          {!isExpired && hasDuplicateAccountCircuits ? (
            <View style={[styles.warningBlock, { backgroundColor: systemColors.tertiaryBackground }]}>
              <Icon name="warning" size={18} color={brandColors.warning} />
              <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.warningText}>
                {t('aurora.status.duplicateAccountCircuits')}
              </Text>
            </View>
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
            {isExpired ? <Button title={t('aurora.card.reconnect')} icon="link" size="small" onPress={onLink} /> : null}
            <Button title={t('aurora.card.import')} icon="upload" variant="outlined" size="small" onPress={onImport} />
            <Button
              title={t('aurora.card.unlink')}
              icon="delete"
              variant="text"
              size="small"
              role="destructive"
              loading={isRemoving}
              disabled={isRemoving}
              onPress={onUnlink}
            />
          </View>
        </>
      ) : variant === 'kilterNew' ? (
        <>
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.accountCopy}>
            {t('aurora.card.kilterNewCopy')}
          </Text>
          <View style={styles.actionRow}>
            <Button title={t('aurora.card.kilterSignIn')} icon="link" size="small" onPress={onLink} />
            <Button title={t('aurora.card.import')} icon="upload" variant="outlined" size="small" onPress={onImport} />
          </View>
        </>
      ) : variant === 'kilterAurora' ? (
        <>
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.accountCopy}>
            {t('aurora.card.kilterAuroraCopy')}
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
                <Button title={tCommon('actions.cancel')} variant="text" role="cancel" onPress={onCancel} />
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
