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
import FileUploadOutlined from '@mui/icons-material/FileUploadOutlined';
import RadioButtonUncheckedOutlined from '@mui/icons-material/RadioButtonUncheckedOutlined';
import type { AuroraCredentialStatus } from '@/app/api/internal/aurora-credentials/route';
import type { UnsyncedCounts } from '@/app/api/internal/aurora-credentials/unsynced/route';
import type { ImportResult } from '@/app/lib/data-sync/aurora/json-import';
import { streamImport } from '@/app/lib/data-sync/aurora/json-import-stream';
import { parseAuroraExport, type AuroraExportPreview, type StrippedExportData } from '@/app/lib/data-sync/aurora/parse-aurora-export';
import styles from './aurora-credentials-section.module.css';

interface BoardUnsyncedCounts {
  ascents: number;
  climbs: number;
}

export type ImportPhase = 'preview' | 'importing' | 'complete' | 'error';

export type ImportStep = 'climbs' | 'resolving' | 'dedup' | 'ascents' | 'attempts' | 'circuits' | 'sessions';

export interface ImportProgress {
  step: ImportStep;
  message?: string;
  current?: number;
  total?: number;
}

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

export interface BoardCredentialCardProps {
  boardType: 'kilter' | 'tension';
  credential: AuroraCredentialStatus | null;
  unsyncedCounts: BoardUnsyncedCounts;
  onAdd: () => void;
  onRemove: () => void;
  onImportJson: () => void;
  isRemoving: boolean;
  isImporting: boolean;
}

export function BoardCredentialCard({
  boardType,
  credential,
  unsyncedCounts,
  onAdd,
  onRemove,
  onImportJson,
  isRemoving,
  isImporting,
}: BoardCredentialCardProps) {
  const boardName = boardType.charAt(0).toUpperCase() + boardType.slice(1);
  const totalUnsynced = unsyncedCounts.ascents + unsyncedCounts.climbs;
  const isKilter = boardType === 'kilter';

  const getSyncStatusTag = () => {
    if (!credential) return null;

    switch (credential.syncStatus) {
      case 'active':
        return (
          <Chip icon={<CheckCircleOutlined />} label="Connected" size="small" color="success" />
        );
      case 'error':
        return (
          <Chip icon={<WarningAmberOutlined />} label="Error" size="small" color="error" />
        );
      case 'expired':
        return (
          <Chip icon={<AccessTimeOutlined />} label="Expired" size="small" color="warning" />
        );
      default:
        return (
          <Chip icon={<SyncOutlined />} label="Syncing" size="small" color="primary" />
        );
    }
  };

  const formatLastSync = (dateString: string | null) => {
    if (!dateString) return 'Never';
    const date = new Date(dateString);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
  };

  if (!credential) {
    return (
      <Card className={styles.credentialCard}>
        <CardContent>
          <div className={styles.cardHeader}>
            <Typography variant="h5" sx={{ margin: 0 }}>
              {boardName} Board
            </Typography>
          </div>
          {isKilter ? (
            <Typography variant="body2" component="span" color="text.secondary" className={styles.notConnectedText}>
              The Kilter backend has been shut down. You can import your data using an Aurora JSON export file.
            </Typography>
          ) : (
            <Typography variant="body2" component="span" color="text.secondary" className={styles.notConnectedText}>
              Not connected. Link your {boardName} account to import your Aurora data, or import from a JSON export file.
            </Typography>
          )}
          <div className={styles.buttonRow}>
            {!isKilter && (
              <Button variant="contained" startIcon={<LinkOutlined />} onClick={onAdd}>
                Link
              </Button>
            )}
            <Button
              variant={isKilter ? 'contained' : 'outlined'}
              startIcon={isImporting ? <CircularProgress size={16} /> : <FileUploadOutlined />}
              onClick={onImportJson}
              disabled={isImporting}
            >
              Import
            </Button>
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
            {boardName} Board
          </Typography>
          {getSyncStatusTag()}
        </div>
        <div className={styles.credentialInfo}>
          <div className={styles.infoRow}>
            <Typography variant="body2" component="span" color="text.secondary">Username:</Typography>
            <Typography variant="body2" component="span" fontWeight={600}>{credential.auroraUsername}</Typography>
          </div>
          <div className={styles.infoRow}>
            <Typography variant="body2" component="span" color="text.secondary">Last synced:</Typography>
            <Typography variant="body2" component="span">{formatLastSync(credential.lastSyncAt)}</Typography>
          </div>
          {credential.syncError && (
            <div className={styles.errorRow}>
              <Typography variant="body2" component="span" color="error">{credential.syncError}</Typography>
            </div>
          )}
          {totalUnsynced > 0 && (
            <MuiAlert severity="warning" icon={<WarningOutlined />} className={styles.unsyncedAlert}>
              <AlertTitle>{`${totalUnsynced} item${totalUnsynced > 1 ? 's' : ''} pending sync`}</AlertTitle>
              <Typography variant="body2" component="span" color="text.secondary">
                {unsyncedCounts.ascents > 0 && `${unsyncedCounts.ascents} ascent${unsyncedCounts.ascents > 1 ? 's' : ''}`}
                {unsyncedCounts.ascents > 0 && unsyncedCounts.climbs > 0 && ', '}
                {unsyncedCounts.climbs > 0 && `${unsyncedCounts.climbs} climb${unsyncedCounts.climbs > 1 ? 's' : ''}`}
              </Typography>
            </MuiAlert>
          )}
        </div>
        <div className={styles.buttonRow}>
          <ConfirmPopover
            title="Remove account link"
            description={`Are you sure you want to unlink your ${boardName} account?`}
            onConfirm={onRemove}
            okText="Yes, unlink"
            okButtonProps={{ color: 'error' }}
          >
            <Button
              color="error"
              variant="outlined"
              startIcon={isRemoving ? <CircularProgress size={16} /> : <DeleteOutlined />}
              disabled={isRemoving}
            >
              Unlink
            </Button>
          </ConfirmPopover>
          <Button
            variant="outlined"
            startIcon={isImporting ? <CircularProgress size={16} /> : <FileUploadOutlined />}
            onClick={onImportJson}
            disabled={isImporting}
          >
            Import
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function ImportProgressSteps({ progress }: { progress: ImportProgress | null }) {
  const currentStepIndex = progress ? STEP_ORDER.indexOf(progress.step) : -1;

  return (
    <div className={styles.progressStepList}>
      {STEP_ORDER.map((step, index) => {
        const isComplete = index < currentStepIndex;
        const isActive = index === currentStepIndex;
        const isPending = index > currentStepIndex;
        const hasCounts = isActive && progress?.current != null && progress?.total != null;
        const progressPercent = hasCounts ? (progress!.current! / progress!.total!) * 100 : 0;

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
                {STEP_LABELS[step]}
                {hasCounts && ` (${progress!.current} / ${progress!.total})`}
              </Typography>
            </div>
            {hasCounts && (
              <LinearProgress
                variant="determinate"
                value={progressPercent}
                sx={{ ml: '32px', mr: 1, mt: 0.5 }}
              />
            )}
            {isActive && !hasCounts && (
              <LinearProgress
                variant="indeterminate"
                sx={{ ml: '32px', mr: 1, mt: 0.5 }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function AuroraCredentialsSection() {
  const { showMessage } = useSnackbar();
  const [credentials, setCredentials] = useState<AuroraCredentialStatus[]>([]);
  const [unsyncedCounts, setUnsyncedCounts] = useState<UnsyncedCounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedBoard, setSelectedBoard] = useState<'kilter' | 'tension'>('kilter');
  const [isSaving, setIsSaving] = useState(false);
  const [removingBoard, setRemovingBoard] = useState<string | null>(null);
  const [formValues, setFormValues] = useState({ username: '', password: '' });

  // Import state
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importingBoard, setImportingBoard] = useState<'kilter' | 'tension' | null>(null);
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
    fetchCredentials();
    fetchUnsyncedCounts();
  }, []);

  const handleAddClick = (boardType: 'kilter' | 'tension') => {
    setSelectedBoard(boardType);
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
        throw new Error(error.error || 'Failed to save credentials');
      }

      if (selectedBoard === 'tension') {
        showMessage('Tension account linked. Your data will show up within 12 hours.', 'success');
      } else {
        showMessage(`${selectedBoard.charAt(0).toUpperCase() + selectedBoard.slice(1)} account linked successfully`, 'success');
      }
      setIsModalOpen(false);
      setFormValues({ username: '', password: '' });
      await fetchCredentials();
    } catch (error) {
      showMessage(error instanceof Error ? error.message : 'Failed to link account', 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleRemove = async (boardType: 'kilter' | 'tension') => {
    setRemovingBoard(boardType);
    try {
      const response = await fetch('/api/internal/aurora-credentials', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ boardType }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to remove credentials');
      }

      showMessage('Account unlinked successfully', 'success');
      await fetchCredentials();
    } catch (error) {
      showMessage(error instanceof Error ? error.message : 'Failed to unlink account', 'error');
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

  const handleImportClick = (boardType: 'kilter' | 'tension') => {
    setImportingBoard(boardType);
    fileInputRef.current?.click();
  };

  const handleFileSelected = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !importingBoard) return;

    // Guard against very large files (200MB limit - exports can be large due to climb data)
    const maxSizeBytes = 200 * 1024 * 1024;
    if (file.size > maxSizeBytes) {
      showMessage('File is too large (max 200MB). Please check you selected the correct file.', 'error');
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
        showMessage(
          err instanceof Error ? err.message : 'Failed to parse JSON file. Please check the file format.',
          'error',
        );
        setImportingBoard(null);
      }
    };
    reader.onerror = () => {
      showMessage('Failed to read file. Please try again.', 'error');
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
              showMessage(`Successfully imported ${totalImported} items`, 'success');
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
        setImportError('Import was interrupted. The server may have timed out. Your data may have been partially imported.');
        setImportPhase('error');
        showMessage('Import was interrupted', 'error');
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Import failed';
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

  const getCredentialForBoard = (boardType: 'kilter' | 'tension') => {
    return credentials.find((c) => c.boardType === boardType) || null;
  };

  const isImporting = importPhase === 'importing';
  const isImportDialogOpen = importPhase === 'preview' || importPhase === 'importing' || importPhase === 'complete' || importPhase === 'error';

  const getImportDialogTitle = () => {
    switch (importPhase) {
      case 'preview': return 'Import Aurora Data';
      case 'importing': return 'Importing Aurora Data...';
      case 'complete': return 'Import Complete';
      case 'error': return 'Import Failed';
      default: return '';
    }
  };

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
          <Typography variant="h5">Board Accounts</Typography>
          <Typography variant="body2" component="span" color="text.secondary" className={styles.sectionDescription}>
            Link your board accounts to import your Aurora data to Boardsesh, or import from a JSON export file.
            We'll automatically sync your logbook, ascents, and climbs FROM Aurora every 12 hours.
            Data created in Boardsesh stays local and does not sync back to Aurora.
          </Typography>

          <Stack spacing={2} className={styles.cardsContainer}>
            <BoardCredentialCard
              boardType="kilter"
              credential={getCredentialForBoard('kilter')}
              unsyncedCounts={unsyncedCounts?.kilter ?? { ascents: 0, climbs: 0 }}
              onAdd={() => handleAddClick('kilter')}
              onRemove={() => handleRemove('kilter')}
              onImportJson={() => handleImportClick('kilter')}
              isRemoving={removingBoard === 'kilter'}
              isImporting={isImporting && importingBoard === 'kilter'}
            />
            <BoardCredentialCard
              boardType="tension"
              credential={getCredentialForBoard('tension')}
              unsyncedCounts={unsyncedCounts?.tension ?? { ascents: 0, climbs: 0 }}
              onAdd={() => handleAddClick('tension')}
              onRemove={() => handleRemove('tension')}
              onImportJson={() => handleImportClick('tension')}
              isRemoving={removingBoard === 'tension'}
              isImporting={isImporting && importingBoard === 'tension'}
            />
          </Stack>
        </CardContent>
      </Card>

      {/* Hidden file input for JSON import */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        onChange={handleFileSelected}
        aria-label="Upload Aurora JSON export file"
        hidden
      />

      {/* Link Account Dialog */}
      <Dialog
        open={isModalOpen}
        onClose={handleModalCancel}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>{`Link ${selectedBoard.charAt(0).toUpperCase() + selectedBoard.slice(1)} Account`}</DialogTitle>
        <DialogContent>
        <Typography variant="body2" component="span" color="text.secondary" className={styles.modalDescription}>
          Enter your {selectedBoard.charAt(0).toUpperCase() + selectedBoard.slice(1)} Board
          username and password to import your Aurora data.
          Your credentials are encrypted and securely stored. Data syncs every 12 hours.
        </Typography>
        <Box
          component="form"
          onSubmit={(e: React.FormEvent) => {
            e.preventDefault();
            const vals = formValues;
            if (!vals.username || !vals.password) return;
            handleSaveCredentials(vals);
          }}
          sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 2 }}
        >
          <TextField
            label="Username"
            placeholder="Enter your username"
            variant="outlined"
            size="small"
            fullWidth
            required
            value={formValues.username}
            onChange={(e) => setFormValues((prev) => ({ ...prev, username: e.target.value }))}
          />

          <TextField
            label="Password"
            type="password"
            placeholder="Enter your password"
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
            {isSaving ? 'Linking...' : 'Link Account'}
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
                Import data from <strong>{importPreview.username}</strong> to{' '}
                <strong>{importingBoard?.charAt(0).toUpperCase()}{importingBoard?.slice(1)}</strong>:
              </Typography>
              <List dense>
                {importPreview.climbs > 0 && (
                  <ListItem>
                    <ListItemText primary={`${importPreview.climbs} draft climbs`} />
                  </ListItem>
                )}
                <ListItem>
                  <ListItemText primary={`${importPreview.ascents} ascents`} />
                </ListItem>
                <ListItem>
                  <ListItemText primary={`${importPreview.attempts} attempts`} />
                </ListItem>
                <ListItem>
                  <ListItemText primary={`${importPreview.circuits} circuits`} />
                </ListItem>
              </List>
              <Typography variant="body2" color="text.secondary">
                Climbs will be matched by name. Any that can't be matched will be reported after import.
                Re-importing the same file will not create duplicates.
              </Typography>
            </>
          )}

          {/* Importing phase */}
          {importPhase === 'importing' && (
            <ImportProgressSteps progress={importProgress} />
          )}

          {/* Complete phase */}
          {importPhase === 'complete' && importResult && (
            <>
              <List dense>
                {(importResult.climbs.imported > 0 || importResult.climbs.failed > 0) && (
                  <ListItem>
                    <ListItemText
                      primary="Draft Climbs"
                      secondary={`${importResult.climbs.imported} imported, ${importResult.climbs.skipped} skipped, ${importResult.climbs.failed} failed`}
                    />
                  </ListItem>
                )}
                <ListItem>
                  <ListItemText
                    primary="Ascents"
                    secondary={`${importResult.ascents.imported} imported, ${importResult.ascents.skipped} skipped (already exist), ${importResult.ascents.failed} unmatched`}
                  />
                </ListItem>
                <ListItem>
                  <ListItemText
                    primary="Attempts"
                    secondary={`${importResult.attempts.imported} imported, ${importResult.attempts.skipped} skipped (already exist), ${importResult.attempts.failed} unmatched`}
                  />
                </ListItem>
                <ListItem>
                  <ListItemText
                    primary="Circuits"
                    secondary={`${importResult.circuits.imported} imported, ${importResult.circuits.skipped} skipped, ${importResult.circuits.failed} failed`}
                  />
                </ListItem>
              </List>
              {importResult.unresolvedClimbs.length > 0 && (
                <MuiAlert severity="warning" className={styles.unsyncedAlert}>
                  <AlertTitle>
                    {importResult.unresolvedClimbs.length} climb{importResult.unresolvedClimbs.length > 1 ? 's' : ''} could not be matched
                  </AlertTitle>
                  <div className={styles.unresolvedList}>
                    {importResult.unresolvedClimbs.slice(0, 20).map((name) => (
                      <Typography key={name} variant="body2">{name}</Typography>
                    ))}
                    {importResult.unresolvedClimbs.length > 20 && (
                      <Typography variant="body2" color="text.secondary">
                        ...and {importResult.unresolvedClimbs.length - 20} more
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
              <AlertTitle>Import failed</AlertTitle>
              {importError}
            </MuiAlert>
          )}
        </DialogContent>

        {/* Actions vary by phase */}
        {importPhase === 'preview' && (
          <DialogActions>
            <Button onClick={handleImportDialogClose}>Cancel</Button>
            <Button variant="contained" onClick={handleImportConfirm}>
              Import
            </Button>
          </DialogActions>
        )}
        {(importPhase === 'complete' || importPhase === 'error') && (
          <DialogActions>
            <Button variant="contained" onClick={handleImportDialogClose}>Close</Button>
          </DialogActions>
        )}
      </Dialog>
    </>
  );
}
