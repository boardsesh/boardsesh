'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import * as Sentry from '@sentry/nextjs';
import Box from '@mui/material/Box';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import MuiAlert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import CircularProgress from '@mui/material/CircularProgress';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import {
  deleteAuroraCredential,
  getAuroraCredentials,
  resolveAuroraBackendTransport,
  saveAuroraCredential,
  type AuroraCredentialStatus,
} from '@/app/lib/aurora-credentials/client';
import type { ImportResult } from '@/app/lib/data-sync/aurora/json-import';
import { streamImport } from '@/app/lib/data-sync/aurora/json-import-stream';
import {
  BoardCredentialCard,
  ImportProgressSteps,
  type ImportPhase,
  type ImportProgress,
} from './aurora-credentials-section';
import {
  parseAuroraExport,
  type AuroraExportPreview,
  type StrippedExportData,
} from '@/app/lib/data-sync/aurora/parse-aurora-export';
import type { AuroraBoardName } from '@boardsesh/shared-schema';
import styles from './aurora-credentials-section.module.css';

type BoardImportPromptProps = {
  boardType: AuroraBoardName;
  onImportComplete?: () => void;
};

export default function BoardImportPrompt({ boardType, onImportComplete }: BoardImportPromptProps) {
  const { t } = useTranslation('settings');
  const { showMessage } = useSnackbar();
  const { token: authToken, isLoading: authTokenLoading } = useWsAuthToken();
  const boardName = boardType.charAt(0).toUpperCase() + boardType.slice(1);

  // Credential state
  const [credential, setCredential] = useState<AuroraCredentialStatus | null>(null);
  const [loadingCredential, setLoadingCredential] = useState(true);
  const [credentialLoadError, setCredentialLoadError] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [formValues, setFormValues] = useState({ username: '', password: '' });

  // Import state
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importPreview, setImportPreview] = useState<AuroraExportPreview | null>(null);
  const [importRawData, setImportRawData] = useState<StrippedExportData | null>(null);
  const [importPhase, setImportPhase] = useState<ImportPhase | null>(null);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const fetchCredential = async () => {
    setCredentialLoadError(false);
    const transport = resolveAuroraBackendTransport(authToken);
    if (!transport) {
      setCredentialLoadError(true);
      setLoadingCredential(false);
      return;
    }

    try {
      const data = await getAuroraCredentials(transport);
      const cred = data.credentials.find((c) => c.boardType === boardType);
      setCredential(cred ?? null);
    } catch (error) {
      console.error('Failed to fetch credentials:', error);
      setCredentialLoadError(true);
    } finally {
      setLoadingCredential(false);
    }
  };

  useEffect(() => {
    if (authTokenLoading) return;
    setLoadingCredential(true);
    void fetchCredential();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authToken, authTokenLoading, boardType]);

  // --- Link Account handlers ---

  const handleAddClick = () => {
    setFormValues({ username: '', password: '' });
    setIsModalOpen(true);
  };

  const handleModalCancel = () => {
    setIsModalOpen(false);
    setFormValues({ username: '', password: '' });
  };

  const handleSaveCredentials = async (values: { username: string; password: string }) => {
    setIsSaving(true);
    try {
      const transport = resolveAuroraBackendTransport(authToken);
      if (!transport) throw new Error(t('aurora.linkDialog.linkError'));

      await saveAuroraCredential(transport, {
        boardType,
        username: values.username,
        password: values.password,
      });

      showMessage(t('aurora.linkDialog.linkSuccess', { boardName }), 'success');
      setIsModalOpen(false);
      setFormValues({ username: '', password: '' });
      await fetchCredential();
    } catch (error) {
      showMessage(error instanceof Error ? error.message : t('aurora.linkDialog.linkError'), 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleRemove = async () => {
    setIsRemoving(true);
    try {
      const transport = resolveAuroraBackendTransport(authToken);
      if (!transport) throw new Error(t('aurora.unlinkError'));

      const result = await deleteAuroraCredential(transport, boardType);

      if (!result.success && result.reason === 'revocation_failed') {
        showMessage(t('aurora.unlinkPartial'), 'warning');
      } else {
        showMessage(t('auroraImport.unlinkSuccessToast'), 'success');
      }
      await fetchCredential();
    } catch (error) {
      showMessage(error instanceof Error ? error.message : t('aurora.unlinkError'), 'error');
    } finally {
      setIsRemoving(false);
    }
  };

  // --- JSON Import handlers ---

  const resetImportState = () => {
    setImportPhase(null);
    setImportProgress(null);
    setImportPreview(null);
    setImportRawData(null);
    setImportResult(null);
    setImportError(null);
  };

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileSelected = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const maxSizeBytes = 200 * 1024 * 1024;
    if (file.size > maxSizeBytes) {
      showMessage(t('aurora.import.tooLarge'), 'error');
      event.target.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const json = JSON.parse(e.target?.result as string);
        const parsed = parseAuroraExport(json, boardType);

        if (parsed.boardWarning) {
          showMessage(parsed.boardWarning, 'warning');
        }

        setImportRawData(parsed.data);
        setImportPreview(parsed.preview);
        setImportPhase('preview');
      } catch (err) {
        showMessage(err instanceof Error ? err.message : t('aurora.import.parseError'), 'error');
      }
    };
    reader.onerror = () => {
      showMessage(t('aurora.import.readError'), 'error');
    };
    reader.readAsText(file);
    event.target.value = '';
  };

  const handleImportConfirm = async () => {
    if (!importRawData) return;

    setImportPhase('importing');
    setImportProgress(null);
    setImportPreview(null);

    try {
      const transport = resolveAuroraBackendTransport(authToken);
      if (!transport) throw new Error(t('aurora.import.failed'));

      await streamImport(
        boardType,
        importRawData,
        (event) => {
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
              setImportResult(event.results);
              setImportPhase('complete');
              onImportComplete?.();
              {
                const totalImported =
                  event.results.climbs.imported +
                  event.results.ascents.imported +
                  event.results.attempts.imported +
                  event.results.circuits.imported;
                if (event.results.partialError) {
                  showMessage(t('aurora.import.partialWarning'), 'warning');
                } else {
                  showMessage(t('aurora.import.successCount', { count: totalImported }), 'success');
                }
              }
              break;
            case 'error':
              setImportError(event.error);
              setImportPhase('error');
              showMessage(event.error, 'error');
              break;
          }
        },
        {
          backendUrl: transport.backendUrl,
          authToken: transport.authToken,
        },
      );
    } catch (error) {
      // streamImport now captures chunk failures itself; reaching here means
      // a setup-level failure (no body, network unreachable, etc.) — worth
      // sending to Sentry so we can spot patterns.
      Sentry.captureException(error, {
        tags: { area: 'aurora-import', phase: 'client-setup' },
        extra: { boardType },
      });
      const msg = error instanceof Error ? error.message : t('aurora.import.failed');
      setImportError(msg);
      setImportPhase('error');
      showMessage(msg, 'error');
    } finally {
      setImportRawData(null);
    }
  };

  const handleImportDialogClose = () => {
    if (importPhase === 'importing') return;
    resetImportState();
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

  if (loadingCredential) return null;

  if (credentialLoadError) {
    return (
      <MuiAlert
        severity="error"
        action={
          <Button
            color="inherit"
            size="small"
            onClick={() => {
              setLoadingCredential(true);
              void fetchCredential();
            }}
          >
            {t('aurora.loadRetry')}
          </Button>
        }
      >
        {t('aurora.mobile.loadFailed')}
      </MuiAlert>
    );
  }

  return (
    <>
      <BoardCredentialCard
        boardType={boardType}
        credential={credential}
        unsyncedCounts={{ ascents: 0, climbs: 0 }}
        onAdd={handleAddClick}
        onRemove={handleRemove}
        onImportJson={handleImportClick}
        isRemoving={isRemoving}
        isImporting={isImporting}
      />

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        onChange={handleFileSelected}
        aria-label={t('auroraImport.uploadAriaLabel')}
        hidden
      />

      {/* Link Account Dialog */}
      <Dialog open={isModalOpen} onClose={handleModalCancel} maxWidth="sm" fullWidth>
        <DialogTitle>{t('aurora.linkDialog.title', { boardName })}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" component="span" color="text.secondary" className={styles.modalDescription}>
            {t('aurora.linkDialog.description', { boardName })}
          </Typography>
          <Box
            component="form"
            onSubmit={(e: React.FormEvent) => {
              e.preventDefault();
              if (!formValues.username || !formValues.password) return;
              void handleSaveCredentials(formValues);
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

      {/* Unified Import Dialog */}
      <Dialog
        open={isImportDialogOpen}
        onClose={handleImportDialogClose}
        maxWidth="sm"
        fullWidth
        disableEscapeKeyDown={isImporting}
      >
        <DialogTitle>{getImportDialogTitle()}</DialogTitle>
        <DialogContent>
          {importPhase === 'preview' && importPreview && (
            <>
              <Typography variant="body2" color="text.secondary" className={styles.modalDescription}>
                <Trans
                  i18nKey="aurora.import.dialog.previewIntro"
                  t={t}
                  values={{ username: importPreview.username, boardName }}
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

          {importPhase === 'importing' && <ImportProgressSteps progress={importProgress} />}

          {importPhase === 'complete' && importResult && (
            <>
              {importResult.partialError && (
                <MuiAlert severity="warning" className={styles.unsyncedAlert}>
                  <AlertTitle>{t('aurora.import.results.partialTitle')}</AlertTitle>
                  <Typography variant="body2">{t('aurora.import.results.partialBody')}</Typography>
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    component="div"
                    sx={{ mt: 1, whiteSpace: 'pre-line' }}
                  >
                    {importResult.partialError}
                  </Typography>
                </MuiAlert>
              )}
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
              {importResult.unresolvedAscentClimbs.length > 0 && (
                <MuiAlert severity="warning" className={styles.unsyncedAlert}>
                  <AlertTitle>
                    {t('aurora.import.results.unresolvedAscentsTitle', {
                      count: importResult.unresolvedAscentClimbs.length,
                    })}
                  </AlertTitle>
                  <div className={styles.unresolvedList}>
                    {importResult.unresolvedAscentClimbs.slice(0, 20).map((name) => (
                      <Typography key={name} variant="body2">
                        {name}
                      </Typography>
                    ))}
                    {importResult.unresolvedAscentClimbs.length > 20 && (
                      <Typography variant="body2" color="text.secondary">
                        {t('aurora.import.results.unresolvedMore', {
                          count: importResult.unresolvedAscentClimbs.length - 20,
                        })}
                      </Typography>
                    )}
                  </div>
                </MuiAlert>
              )}
              {importResult.unresolvedAttemptClimbs.length > 0 && (
                <MuiAlert severity="warning" className={styles.unsyncedAlert}>
                  <AlertTitle>
                    {t('aurora.import.results.unresolvedAttemptsTitle', {
                      count: importResult.unresolvedAttemptClimbs.length,
                    })}
                  </AlertTitle>
                  <div className={styles.unresolvedList}>
                    {importResult.unresolvedAttemptClimbs.slice(0, 20).map((name) => (
                      <Typography key={name} variant="body2">
                        {name}
                      </Typography>
                    ))}
                    {importResult.unresolvedAttemptClimbs.length > 20 && (
                      <Typography variant="body2" color="text.secondary">
                        {t('aurora.import.results.unresolvedMore', {
                          count: importResult.unresolvedAttemptClimbs.length - 20,
                        })}
                      </Typography>
                    )}
                  </div>
                </MuiAlert>
              )}
              {importResult.unresolvedCircuitClimbs.length > 0 && (
                <MuiAlert severity="warning" className={styles.unsyncedAlert}>
                  <AlertTitle>
                    {t('aurora.import.results.unresolvedCircuitsTitle', {
                      count: importResult.unresolvedCircuitClimbs.length,
                    })}
                  </AlertTitle>
                  <div className={styles.unresolvedList}>
                    {importResult.unresolvedCircuitClimbs.slice(0, 20).map((name) => (
                      <Typography key={name} variant="body2">
                        {name}
                      </Typography>
                    ))}
                    {importResult.unresolvedCircuitClimbs.length > 20 && (
                      <Typography variant="body2" color="text.secondary">
                        {t('aurora.import.results.unresolvedMore', {
                          count: importResult.unresolvedCircuitClimbs.length - 20,
                        })}
                      </Typography>
                    )}
                  </div>
                </MuiAlert>
              )}
            </>
          )}

          {importPhase === 'error' && importError && (
            <MuiAlert severity="error">
              <AlertTitle>{t('aurora.import.dialog.errorTitleShort')}</AlertTitle>
              {importError}
            </MuiAlert>
          )}
        </DialogContent>

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
