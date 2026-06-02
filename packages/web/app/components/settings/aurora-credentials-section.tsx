'use client';

import React, { useState, useEffect, useRef } from 'react';
import Box from '@mui/material/Box';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import MuiAlert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import LinearProgress from '@mui/material/LinearProgress';
import { ConfirmPopover } from '@/app/components/ui/confirm-popover';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { LoadingSpinner } from '@/app/components/ui/loading-spinner';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import TextField from '@mui/material/TextField';
import CircularProgress from '@mui/material/CircularProgress';
import CheckCircleOutlined from '@mui/icons-material/CheckCircleOutlined';
import WarningAmberOutlined from '@mui/icons-material/WarningAmberOutlined';
import AccessTimeOutlined from '@mui/icons-material/AccessTimeOutlined';
import DeleteOutlined from '@mui/icons-material/DeleteOutlined';
import LinkOutlined from '@mui/icons-material/LinkOutlined';
import SyncOutlined from '@mui/icons-material/SyncOutlined';
import WarningOutlined from '@mui/icons-material/WarningOutlined';
import EmailOutlined from '@mui/icons-material/EmailOutlined';
import FileUploadOutlined from '@mui/icons-material/FileUploadOutlined';
import RadioButtonUncheckedOutlined from '@mui/icons-material/RadioButtonUncheckedOutlined';
import { useSession } from 'next-auth/react';
import { Trans, useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { AuroraCredentialStatus } from '@/app/api/internal/aurora-credentials/route';
import type { UnsyncedCounts } from '@/app/api/internal/aurora-credentials/unsynced/route';
import type { ImportResult } from '@/app/lib/data-sync/aurora/json-import';
import { streamImport } from '@/app/lib/data-sync/aurora/json-import-stream';
import {
  parseAuroraExport,
  type AuroraExportPreview,
  type StrippedExportData,
} from '@/app/lib/data-sync/aurora/parse-aurora-export';
import { AURORA_BOARDS, type AuroraBoardName } from '@boardsesh/shared-schema';
import styles from './aurora-credentials-section.module.css';

type BoardUnsyncedCounts = {
  ascents: number;
  climbs: number;
};

export type ImportPhase = 'preview' | 'importing' | 'complete' | 'error';

export type ImportStep = 'climbs' | 'resolving' | 'dedup' | 'ascents' | 'attempts' | 'circuits' | 'sessions';

export type ImportProgress = {
  step: ImportStep;
  message?: string;
  current?: number;
  total?: number;
};

export const STEP_ORDER: ImportStep[] = ['climbs', 'resolving', 'dedup', 'ascents', 'attempts', 'circuits', 'sessions'];

export const STEP_LABELS: Record<ImportStep, string> = {
  climbs: 'Importing draft climbs',
  resolving: 'Resolving climb names',
  dedup: 'Checking for duplicates',
  ascents: 'Importing ascents',
  attempts: 'Importing attempts',
  circuits: 'Importing circuits',
  sessions: 'Building sessions',
};

function getStepLabels(t: TFunction<'settings'>): Record<ImportStep, string> {
  return {
    climbs: t('aurora.import.steps.climbs'),
    resolving: t('aurora.import.steps.resolving'),
    dedup: t('aurora.import.steps.dedup'),
    ascents: t('aurora.import.steps.ascents'),
    attempts: t('aurora.import.steps.attempts'),
    circuits: t('aurora.import.steps.circuits'),
    sessions: t('aurora.import.steps.sessions'),
  };
}

function buildKilterDataRequestMailto(
  t: TFunction<'settings'>,
  userName?: string | null,
  userEmail?: string | null,
): string {
  const name = userName || t('aurora.kilterEmail.namePlaceholder');
  const email = userEmail || t('aurora.kilterEmail.emailPlaceholder');
  const subject = t('aurora.kilterEmail.subject');
  const body = t('aurora.kilterEmail.body', { name, email });

  return `mailto:peter@auroraclimbing.com?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export type BoardCredentialCardProps = {
  boardType: AuroraBoardName;
  credential: AuroraCredentialStatus | null;
  unsyncedCounts: BoardUnsyncedCounts;
  onAdd: () => void;
  onRemove: () => void;
  onImportJson: () => void;
  isRemoving: boolean;
  isImporting: boolean;
  userName?: string | null;
  userEmail?: string | null;
  /**
   * When true and the user has no Kilter credential yet, render the
   * "Connect Kilter account" OAuth button instead of the shut-down notice.
   * Allowlist-gated via KILTER_SYNC_ALLOWED_USER_IDS — see
   * packages/web/app/lib/kilter-sync/access.ts.
   */
  kilterSyncEnabled?: boolean;
};

export function BoardCredentialCard({
  boardType,
  credential,
  unsyncedCounts,
  onAdd,
  onRemove,
  onImportJson,
  isRemoving,
  isImporting,
  userName,
  userEmail,
  kilterSyncEnabled = false,
}: BoardCredentialCardProps) {
  const { t } = useTranslation('settings');
  const boardName = boardType.charAt(0).toUpperCase() + boardType.slice(1);
  const totalUnsynced = unsyncedCounts.ascents + unsyncedCounts.climbs;
  const isKilter = boardType === 'kilter';

  const getSyncStatusTag = () => {
    if (!credential) return null;

    switch (credential.syncStatus) {
      case 'active':
        return (
          <Chip icon={<CheckCircleOutlined />} label={t('aurora.status.connected')} size="small" color="success" />
        );
      case 'error':
        return <Chip icon={<WarningAmberOutlined />} label={t('aurora.status.error')} size="small" color="error" />;
      case 'expired':
        return <Chip icon={<AccessTimeOutlined />} label={t('aurora.status.expired')} size="small" color="warning" />;
      default:
        return <Chip icon={<SyncOutlined />} label={t('aurora.status.syncing')} size="small" color="primary" />;
    }
  };

  const formatLastSync = (dateString: string | null) => {
    if (!dateString) return t('aurora.card.never');
    const date = new Date(dateString);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
  };

  if (!credential) {
    return (
      <Card className={styles.credentialCard}>
        <CardContent>
          <div className={styles.cardHeader}>
            <Typography variant="h5" sx={{ margin: 0 }}>
              {boardName} {t('aurora.card.boardSuffix')}
            </Typography>
          </div>
          {isKilter ? (
            <Typography variant="body2" component="span" color="text.secondary" className={styles.notConnectedText}>
              {kilterSyncEnabled ? t('aurora.card.kilterConnectCopy') : t('aurora.card.kilterShutdown')}
            </Typography>
          ) : (
            <Typography variant="body2" component="span" color="text.secondary" className={styles.notConnectedText}>
              {t('aurora.card.notConnected', { boardName })}
            </Typography>
          )}
          <div className={isKilter ? styles.buttonRowStacked : styles.buttonRow}>
            {!isKilter && (
              <Button variant="contained" startIcon={<LinkOutlined />} onClick={onAdd}>
                {t('aurora.card.link')}
              </Button>
            )}
            {isKilter && kilterSyncEnabled && (
              <Button
                variant="contained"
                startIcon={<LinkOutlined />}
                href="/api/internal/board-credentials/kilter/start"
              >
                {t('aurora.card.kilterConnectButton')}
              </Button>
            )}
            <Button
              variant={isKilter && !kilterSyncEnabled ? 'contained' : 'outlined'}
              startIcon={isImporting ? <CircularProgress size={16} /> : <FileUploadOutlined />}
              onClick={onImportJson}
              disabled={isImporting}
            >
              {t('aurora.card.import')}
            </Button>
            {isKilter && !kilterSyncEnabled && (
              <Button
                variant="outlined"
                startIcon={<EmailOutlined />}
                href={buildKilterDataRequestMailto(t, userName, userEmail)}
              >
                {t('aurora.card.requestData')}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={styles.credentialCard}>
      <CardContent>
        <div className={styles.cardHeader}>
          <Typography variant="h5" sx={{ margin: 0 }}>
            {boardName} {t('aurora.card.boardSuffix')}
          </Typography>
          {getSyncStatusTag()}
        </div>
        <div className={styles.credentialInfo}>
          <div className={styles.infoRow}>
            <Typography variant="body2" component="span" color="text.secondary">
              {t('aurora.card.username')}
            </Typography>
            <Typography variant="body2" component="span" fontWeight={600}>
              {credential.auroraUsername}
            </Typography>
          </div>
          <div className={styles.infoRow}>
            <Typography variant="body2" component="span" color="text.secondary">
              {t('aurora.card.lastSynced')}
            </Typography>
            <Typography variant="body2" component="span">
              {formatLastSync(credential.lastSyncAt)}
            </Typography>
          </div>
          {credential.syncError && (
            <div className={styles.errorRow}>
              <Typography variant="body2" component="span" color="error">
                {credential.syncError}
              </Typography>
            </div>
          )}
          {totalUnsynced > 0 && (
            <MuiAlert severity="warning" icon={<WarningOutlined />} className={styles.unsyncedAlert}>
              <AlertTitle>{t('aurora.unsynced.title', { count: totalUnsynced })}</AlertTitle>
              <Typography variant="body2" component="span" color="text.secondary">
                {unsyncedCounts.ascents > 0 && t('aurora.unsynced.ascents', { count: unsyncedCounts.ascents })}
                {unsyncedCounts.ascents > 0 && unsyncedCounts.climbs > 0 && ', '}
                {unsyncedCounts.climbs > 0 && t('aurora.unsynced.climbs', { count: unsyncedCounts.climbs })}
              </Typography>
            </MuiAlert>
          )}
        </div>
        <div className={styles.buttonRow}>
          <ConfirmPopover
            title={t('aurora.card.unlinkConfirm.title')}
            description={t('aurora.card.unlinkConfirm.description', { boardName })}
            onConfirm={onRemove}
            okText={t('aurora.card.unlinkConfirm.ok')}
            okButtonProps={{ color: 'error' }}
          >
            <Button
              color="error"
              variant="outlined"
              startIcon={isRemoving ? <CircularProgress size={16} /> : <DeleteOutlined />}
              disabled={isRemoving}
            >
              {t('aurora.card.unlink')}
            </Button>
          </ConfirmPopover>
          <Button
            variant="outlined"
            startIcon={isImporting ? <CircularProgress size={16} /> : <FileUploadOutlined />}
            onClick={onImportJson}
            disabled={isImporting}
          >
            {t('aurora.card.import')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function ImportProgressSteps({ progress }: { progress: ImportProgress | null }) {
  const { t } = useTranslation('settings');
  const stepLabels = getStepLabels(t);
  const currentStepIndex = progress ? STEP_ORDER.indexOf(progress.step) : -1;

  return (
    <div className={styles.progressStepList}>
      {STEP_ORDER.map((step, index) => {
        const isComplete = index < currentStepIndex;
        const isActive = index === currentStepIndex;
        const isPending = index > currentStepIndex;
        const hasCounts = isActive && progress?.current != null && progress?.total != null;
        const progressPercent = hasCounts ? (progress.current! / progress.total!) * 100 : 0;

        return (
          <div key={step} className={styles.progressStep}>
            <div className={styles.progressStepHeader}>
              {isComplete && <CheckCircleOutlined color="success" fontSize="small" />}
              {isActive && <CircularProgress size={20} />}
              {isPending && <RadioButtonUncheckedOutlined color="disabled" fontSize="small" />}
              <Typography
                variant="body2"
                color={isPending ? 'text.disabled' : 'text.primary'}
                fontWeight={isActive ? 600 : 400}
              >
                {stepLabels[step]}
                {hasCounts && ` (${progress.current} / ${progress.total})`}
              </Typography>
            </div>
            {hasCounts && (
              <LinearProgress variant="determinate" value={progressPercent} sx={{ ml: '32px', mr: 1, mt: 0.5 }} />
            )}
            {isActive && !hasCounts && <LinearProgress variant="indeterminate" sx={{ ml: '32px', mr: 1, mt: 0.5 }} />}
          </div>
        );
      })}
    </div>
  );
}

export default function AuroraCredentialsSection() {
  const { t } = useTranslation('settings');
  const { data: session } = useSession();
  const { showMessage } = useSnackbar();
  const [credentials, setCredentials] = useState<AuroraCredentialStatus[]>([]);
  const [unsyncedCounts, setUnsyncedCounts] = useState<UnsyncedCounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [kilterSyncAllowed, setKilterSyncAllowed] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedBoard, setSelectedBoard] = useState<AuroraBoardName>('kilter');
  const [isSaving, setIsSaving] = useState(false);
  const [removingBoard, setRemovingBoard] = useState<string | null>(null);
  const [formValues, setFormValues] = useState({ username: '', password: '' });

  // Import state
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importingBoard, setImportingBoard] = useState<AuroraBoardName | null>(null);
  const [importPreview, setAuroraExportPreview] = useState<AuroraExportPreview | null>(null);
  const [importRawData, setImportRawData] = useState<StrippedExportData | null>(null);
  const [importPhase, setImportPhase] = useState<ImportPhase | null>(null);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const receivedCompleteRef = useRef(false);

  const fetchCredentials = async () => {
    try {
      const response = await fetch('/api/internal/aurora-credentials');
      if (response.ok) {
        const data = await response.json();
        setCredentials(data.credentials);
      }
    } catch (error) {
      console.error('Failed to fetch credentials:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchUnsyncedCounts = async () => {
    try {
      const response = await fetch('/api/internal/aurora-credentials/unsynced');
      if (response.ok) {
        const data = await response.json();
        setUnsyncedCounts(data.counts);
      }
    } catch (error) {
      console.error('Failed to fetch unsynced counts:', error);
    }
  };

  useEffect(() => {
    void fetchCredentials();
    void fetchUnsyncedCounts();
    // One-shot check for kilter-sync feature flag. Failures fall back to
    // false (the Settings card just hides the Connect button), so a
    // backend hiccup never blocks the page render.
    void (async () => {
      try {
        const response = await fetch('/api/internal/kilter-sync/access');
        if (!response.ok) return;
        const data = (await response.json()) as { allowed?: boolean };
        if (data.allowed === true) setKilterSyncAllowed(true);
      } catch {
        // Stay disabled on any failure — fail closed.
      }
    })();
  }, []);

  const handleAddClick = (boardType: AuroraBoardName) => {
    setSelectedBoard(boardType);
    setFormValues({ username: '', password: '' });
    setIsModalOpen(true);
  };

  const handleModalCancel = () => {
    setIsModalOpen(false);
    setFormValues({ username: '', password: '' });
  };

  const selectedBoardName = selectedBoard.charAt(0).toUpperCase() + selectedBoard.slice(1);

  const handleSaveCredentials = async (values: { username: string; password: string }) => {
    setIsSaving(true);
    try {
      const response = await fetch('/api/internal/aurora-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          boardType: selectedBoard,
          username: values.username,
          password: values.password,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || t('aurora.linkDialog.linkError'));
      }

      showMessage(t('aurora.linkDialog.linkSuccess', { boardName: selectedBoardName }), 'success');
      setIsModalOpen(false);
      setFormValues({ username: '', password: '' });
      await fetchCredentials();
    } catch (error) {
      showMessage(error instanceof Error ? error.message : t('aurora.linkDialog.linkError'), 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleRemove = async (boardType: AuroraBoardName) => {
    setRemovingBoard(boardType);
    try {
      // Kilter routes through its OAuth-aware disconnect endpoint, which
      // revokes the refresh token at Keycloak before the local DELETE.
      // The legacy /api/internal/aurora-credentials DELETE only cleans
      // up local rows — fine for Aurora (username/password creds with
      // no remote session) but leaves the Keycloak refresh token live
      // for its full TTL after a Kilter disconnect.
      const url =
        boardType === 'kilter'
          ? '/api/internal/board-credentials/kilter/disconnect'
          : '/api/internal/aurora-credentials';
      const init: RequestInit =
        boardType === 'kilter'
          ? { method: 'POST' }
          : {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ boardType }),
            };
      const response = await fetch(url, init);

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || t('aurora.unlinkError'));
      }

      // 207 Multi-Status from the kilter disconnect route means: local
      // rows ARE gone, but Keycloak token revocation failed. The user
      // believes they disconnected; warn them the IdP-side session may
      // still be live so they can manually expire it via the Kilter
      // portal. Without this, an outage at Keycloak silently leaves a
      // refresh token usable for its full TTL.
      if (response.status === 207) {
        showMessage(t('aurora.unlinkPartial'), 'warning');
      } else {
        showMessage(t('aurora.unlinkSuccess'), 'success');
      }
      await fetchCredentials();
    } catch (error) {
      showMessage(error instanceof Error ? error.message : t('aurora.unlinkError'), 'error');
    } finally {
      setRemovingBoard(null);
    }
  };

  // --- JSON Import handlers ---

  const resetImportState = () => {
    setImportPhase(null);
    setImportProgress(null);
    setAuroraExportPreview(null);
    setImportRawData(null);
    setImportingBoard(null);
    setImportResult(null);
    setImportError(null);
  };

  const handleImportClick = (boardType: AuroraBoardName) => {
    setImportingBoard(boardType);
    fileInputRef.current?.click();
  };

  const handleFileSelected = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !importingBoard) return;

    // Guard against very large files (200MB limit - exports can be large due to climb data)
    const maxSizeBytes = 200 * 1024 * 1024;
    if (file.size > maxSizeBytes) {
      showMessage(t('aurora.import.tooLarge'), 'error');
      setImportingBoard(null);
      event.target.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const json = JSON.parse(e.target?.result as string);
        const parsed = parseAuroraExport(json, importingBoard);

        if (parsed.boardWarning) {
          showMessage(parsed.boardWarning, 'warning');
        }

        setImportRawData(parsed.data);
        setAuroraExportPreview(parsed.preview);
        setImportPhase('preview');
      } catch (err) {
        showMessage(err instanceof Error ? err.message : t('aurora.import.parseError'), 'error');
        setImportingBoard(null);
      }
    };
    reader.onerror = () => {
      showMessage(t('aurora.import.readError'), 'error');
      setImportingBoard(null);
    };
    reader.readAsText(file);

    // Reset input so the same file can be re-selected
    event.target.value = '';
  };

  const handleImportConfirm = async () => {
    if (!importingBoard || !importRawData) return;

    setImportPhase('importing');
    setImportProgress(null);
    setAuroraExportPreview(null);
    receivedCompleteRef.current = false;

    try {
      await streamImport(importingBoard, importRawData, (event) => {
        switch (event.type) {
          case 'progress':
            setImportProgress({
              step: event.step,
              message: 'message' in event ? event.message : undefined,
              current: 'current' in event ? event.current : undefined,
              total: 'total' in event ? event.total : undefined,
            });
            break;
          case 'complete':
            receivedCompleteRef.current = true;
            setImportResult(event.results);
            setImportPhase('complete');
            {
              const totalImported =
                event.results.climbs.imported +
                event.results.ascents.imported +
                event.results.attempts.imported +
                event.results.circuits.imported;
              showMessage(t('aurora.import.successCount', { count: totalImported }), 'success');
            }
            break;
          case 'error':
            receivedCompleteRef.current = true;
            setImportError(event.error);
            setImportPhase('error');
            showMessage(event.error, 'error');
            break;
        }
      });

      // If stream ended without a complete/error event (e.g. server timeout)
      if (!receivedCompleteRef.current) {
        setImportError(t('aurora.import.interrupted'));
        setImportPhase('error');
        showMessage(t('aurora.import.interruptedShort'), 'error');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : t('aurora.import.failed');
      setImportError(message);
      setImportPhase('error');
      showMessage(message, 'error');
    } finally {
      setImportRawData(null);
    }
  };

  const handleImportDialogClose = () => {
    if (importPhase === 'importing') return;
    resetImportState();
  };

  const getCredentialForBoard = (boardType: AuroraBoardName) => {
    return credentials.find((credential) => credential.boardType === boardType) || null;
  };

  const isImporting = importPhase === 'importing';
  const isImportDialogOpen =
    importPhase === 'preview' || importPhase === 'importing' || importPhase === 'complete' || importPhase === 'error';

  const getImportDialogTitle = () => {
    switch (importPhase) {
      case 'preview':
        return t('aurora.import.dialog.previewTitle');
      case 'importing':
        return t('aurora.import.dialog.importingTitle');
      case 'complete':
        return t('aurora.import.dialog.completeTitle');
      case 'error':
        return t('aurora.import.dialog.errorTitle');
      default:
        return '';
    }
  };

  const importingBoardName = importingBoard ? importingBoard.charAt(0).toUpperCase() + importingBoard.slice(1) : '';

  if (loading) {
    return (
      <Card>
        <CardContent>
          <div className={styles.loadingContainer}>
            <LoadingSpinner />
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardContent>
          <Typography variant="h5">{t('aurora.title')}</Typography>
          <Typography variant="body2" component="span" color="text.secondary" className={styles.sectionDescription}>
            {t('aurora.subtitle')}
          </Typography>

          <Stack spacing={2} className={styles.cardsContainer}>
            {AURORA_BOARDS.map((boardType) => (
              <BoardCredentialCard
                key={boardType}
                boardType={boardType}
                credential={getCredentialForBoard(boardType)}
                unsyncedCounts={unsyncedCounts?.[boardType] ?? { ascents: 0, climbs: 0 }}
                onAdd={() => handleAddClick(boardType)}
                onRemove={() => handleRemove(boardType)}
                onImportJson={() => handleImportClick(boardType)}
                isRemoving={removingBoard === boardType}
                isImporting={isImporting && importingBoard === boardType}
                userName={boardType === 'kilter' ? session?.user?.name : undefined}
                userEmail={boardType === 'kilter' ? session?.user?.email : undefined}
                kilterSyncEnabled={boardType === 'kilter' && kilterSyncAllowed}
              />
            ))}
          </Stack>
        </CardContent>
      </Card>

      {/* Hidden file input for JSON import */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        onChange={handleFileSelected}
        aria-label={t('aurora.import.fileLabel')}
        hidden
      />

      {/* Link Account Dialog */}
      <Dialog open={isModalOpen} onClose={handleModalCancel} maxWidth="sm" fullWidth>
        <DialogTitle>{t('aurora.linkDialog.title', { boardName: selectedBoardName })}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" component="span" color="text.secondary" className={styles.modalDescription}>
            {t('aurora.linkDialog.description', { boardName: selectedBoardName })}
          </Typography>
          <Box
            component="form"
            onSubmit={(e: React.FormEvent) => {
              e.preventDefault();
              const vals = formValues;
              if (!vals.username || !vals.password) return;
              void handleSaveCredentials(vals);
            }}
            sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 2 }}
          >
            <TextField
              label={t('aurora.linkDialog.usernameLabel')}
              placeholder={t('aurora.linkDialog.usernamePlaceholder')}
              variant="outlined"
              size="small"
              fullWidth
              required
              value={formValues.username}
              onChange={(e) => setFormValues((prev) => ({ ...prev, username: e.target.value }))}
            />

            <TextField
              label={t('aurora.linkDialog.passwordLabel')}
              type="password"
              placeholder={t('aurora.linkDialog.passwordPlaceholder')}
              variant="outlined"
              size="small"
              fullWidth
              required
              value={formValues.password}
              onChange={(e) => setFormValues((prev) => ({ ...prev, password: e.target.value }))}
            />

            <Button
              variant="contained"
              type="submit"
              disabled={isSaving}
              startIcon={isSaving ? <CircularProgress size={16} /> : undefined}
              fullWidth
            >
              {isSaving ? t('aurora.linkDialog.submitting') : t('aurora.linkDialog.submit')}
            </Button>
          </Box>
        </DialogContent>
      </Dialog>

      {/* Unified Import Dialog (preview → progress → complete/error) */}
      <Dialog
        open={isImportDialogOpen}
        onClose={handleImportDialogClose}
        maxWidth="sm"
        fullWidth
        disableEscapeKeyDown={isImporting}
      >
        <DialogTitle>{getImportDialogTitle()}</DialogTitle>
        <DialogContent>
          {/* Preview phase */}
          {importPhase === 'preview' && importPreview && (
            <>
              <Typography variant="body2" color="text.secondary" className={styles.modalDescription}>
                <Trans
                  i18nKey="aurora.import.dialog.previewIntro"
                  t={t}
                  values={{ username: importPreview.username, boardName: importingBoardName }}
                  components={{ strong: <strong /> }}
                />
              </Typography>
              <List dense>
                {importPreview.climbs > 0 && (
                  <ListItem>
                    <ListItemText primary={t('aurora.import.dialog.draftClimbs', { count: importPreview.climbs })} />
                  </ListItem>
                )}
                <ListItem>
                  <ListItemText primary={t('aurora.import.dialog.ascents', { count: importPreview.ascents })} />
                </ListItem>
                <ListItem>
                  <ListItemText primary={t('aurora.import.dialog.attempts', { count: importPreview.attempts })} />
                </ListItem>
                <ListItem>
                  <ListItemText primary={t('aurora.import.dialog.circuits', { count: importPreview.circuits })} />
                </ListItem>
              </List>
              <Typography variant="body2" color="text.secondary">
                {t('aurora.import.dialog.previewNote')}
              </Typography>
            </>
          )}

          {/* Importing phase */}
          {importPhase === 'importing' && <ImportProgressSteps progress={importProgress} />}

          {/* Complete phase */}
          {importPhase === 'complete' && importResult && (
            <>
              <List dense>
                {(importResult.climbs.imported > 0 || importResult.climbs.failed > 0) && (
                  <ListItem>
                    <ListItemText
                      primary={t('aurora.import.results.draftClimbs')}
                      secondary={t('aurora.import.results.draftClimbsSummary', {
                        imported: importResult.climbs.imported,
                        skipped: importResult.climbs.skipped,
                        failed: importResult.climbs.failed,
                      })}
                    />
                  </ListItem>
                )}
                <ListItem>
                  <ListItemText
                    primary={t('aurora.import.results.ascents')}
                    secondary={t('aurora.import.results.ascentsSummary', {
                      imported: importResult.ascents.imported,
                      skipped: importResult.ascents.skipped,
                      failed: importResult.ascents.failed,
                    })}
                  />
                </ListItem>
                <ListItem>
                  <ListItemText
                    primary={t('aurora.import.results.attempts')}
                    secondary={t('aurora.import.results.attemptsSummary', {
                      imported: importResult.attempts.imported,
                      skipped: importResult.attempts.skipped,
                      failed: importResult.attempts.failed,
                    })}
                  />
                </ListItem>
                <ListItem>
                  <ListItemText
                    primary={t('aurora.import.results.circuits')}
                    secondary={t('aurora.import.results.circuitsSummary', {
                      imported: importResult.circuits.imported,
                      skipped: importResult.circuits.skipped,
                      failed: importResult.circuits.failed,
                    })}
                  />
                </ListItem>
              </List>
              {importResult.unresolvedClimbs.length > 0 && (
                <MuiAlert severity="warning" className={styles.unsyncedAlert}>
                  <AlertTitle>
                    {t('aurora.import.results.unresolvedTitle', { count: importResult.unresolvedClimbs.length })}
                  </AlertTitle>
                  <div className={styles.unresolvedList}>
                    {importResult.unresolvedClimbs.slice(0, 20).map((name) => (
                      <Typography key={name} variant="body2">
                        {name}
                      </Typography>
                    ))}
                    {importResult.unresolvedClimbs.length > 20 && (
                      <Typography variant="body2" color="text.secondary">
                        {t('aurora.import.results.unresolvedMore', {
                          count: importResult.unresolvedClimbs.length - 20,
                        })}
                      </Typography>
                    )}
                  </div>
                </MuiAlert>
              )}
            </>
          )}

          {/* Error phase */}
          {importPhase === 'error' && importError && (
            <MuiAlert severity="error">
              <AlertTitle>{t('aurora.import.dialog.errorTitleShort')}</AlertTitle>
              {importError}
            </MuiAlert>
          )}
        </DialogContent>

        {/* Actions vary by phase */}
        {importPhase === 'preview' && (
          <DialogActions>
            <Button onClick={handleImportDialogClose}>{t('aurora.import.dialog.cancel')}</Button>
            <Button variant="contained" onClick={handleImportConfirm}>
              {t('aurora.import.dialog.confirm')}
            </Button>
          </DialogActions>
        )}
        {(importPhase === 'complete' || importPhase === 'error') && (
          <DialogActions>
            <Button variant="contained" onClick={handleImportDialogClose}>
              {t('aurora.import.dialog.close')}
            </Button>
          </DialogActions>
        )}
      </Dialog>
    </>
  );
}
