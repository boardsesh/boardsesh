'use client';

import React, { useState, useEffect, useRef } from 'react';
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
import type { AuroraCredentialStatus } from '@/app/api/internal/aurora-credentials/route';
import type { ImportResult } from '@/app/lib/data-sync/aurora/json-import';
import { streamImport } from '@/app/lib/data-sync/aurora/json-import-stream';
import {
  BoardCredentialCard,
  ImportProgressSteps,
  type ImportPhase,
  type ImportProgress,
} from './aurora-credentials-section';
import { parseAuroraExport, type AuroraExportPreview, type StrippedExportData } from '@/app/lib/data-sync/aurora/parse-aurora-export';
import styles from './aurora-credentials-section.module.css';

interface BoardImportPromptProps {
  boardType: 'kilter' | 'tension';
  onImportComplete?: () => void;
}

export default function BoardImportPrompt({ boardType, onImportComplete }: BoardImportPromptProps) {
  const { showMessage } = useSnackbar();
  const boardName = boardType.charAt(0).toUpperCase() + boardType.slice(1);

  // Credential state
  const [credential, setCredential] = useState<AuroraCredentialStatus | null>(null);
  const [loadingCredential, setLoadingCredential] = useState(true);
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
  const receivedCompleteRef = useRef(false);

  const fetchCredential = async () => {
    try {
      const response = await fetch('/api/internal/aurora-credentials');
      if (response.ok) {
        const data = await response.json();
        const cred = (data.credentials as AuroraCredentialStatus[]).find(
          (c) => c.boardType === boardType,
        );
        setCredential(cred ?? null);
      }
    } catch (error) {
      console.error('Failed to fetch credentials:', error);
    } finally {
      setLoadingCredential(false);
    }
  };

  useEffect(() => {
    fetchCredential();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardType]);

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
      const response = await fetch('/api/internal/aurora-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          boardType,
          username: values.username,
          password: values.password,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to save credentials');
      }

      if (boardType === 'tension') {
        showMessage('Tension account linked. Your data will show up within 12 hours.', 'success');
      } else {
        showMessage(`${boardName} account linked successfully`, 'success');
      }
      setIsModalOpen(false);
      setFormValues({ username: '', password: '' });
      await fetchCredential();
    } catch (error) {
      showMessage(error instanceof Error ? error.message : 'Failed to link account', 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleRemove = async () => {
    setIsRemoving(true);
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
      await fetchCredential();
    } catch (error) {
      showMessage(error instanceof Error ? error.message : 'Failed to unlink account', 'error');
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
      showMessage('File is too large (max 200MB). Please check you selected the correct file.', 'error');
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
        showMessage(
          err instanceof Error ? err.message : 'Failed to parse JSON file. Please check the file format.',
          'error',
        );
      }
    };
    reader.onerror = () => {
      showMessage('Failed to read file. Please try again.', 'error');
    };
    reader.readAsText(file);
    event.target.value = '';
  };

  const handleImportConfirm = async () => {
    if (!importRawData) return;

    setImportPhase('importing');
    setImportProgress(null);
    setImportPreview(null);
    receivedCompleteRef.current = false;

    try {
      await streamImport(boardType, importRawData, (event) => {
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
            onImportComplete?.();
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

  if (loadingCredential) return null;

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
        aria-label="Upload Aurora JSON export file"
        hidden
      />

      {/* Link Account Dialog */}
      <Dialog open={isModalOpen} onClose={handleModalCancel} maxWidth="sm" fullWidth>
        <DialogTitle>{`Link ${boardName} Account`}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" component="span" color="text.secondary" className={styles.modalDescription}>
            Enter your {boardName} Board username and password to import your Aurora data.
            Your credentials are encrypted and securely stored. Data syncs every 12 hours.
          </Typography>
          <Box
            component="form"
            onSubmit={(e: React.FormEvent) => {
              e.preventDefault();
              if (!formValues.username || !formValues.password) return;
              handleSaveCredentials(formValues);
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
                Import data from <strong>{importPreview.username}</strong> to{' '}
                <strong>{boardName}</strong>:
              </Typography>
              <List dense>
                {importPreview.climbs > 0 && (
                  <ListItem><ListItemText primary={`${importPreview.climbs} draft climbs`} /></ListItem>
                )}
                <ListItem><ListItemText primary={`${importPreview.ascents} ascents`} /></ListItem>
                <ListItem><ListItemText primary={`${importPreview.attempts} attempts`} /></ListItem>
                <ListItem><ListItemText primary={`${importPreview.circuits} circuits`} /></ListItem>
              </List>
              <Typography variant="body2" color="text.secondary">
                Climbs will be matched by name. Any that can't be matched will be reported after import.
                Re-importing the same file will not create duplicates.
              </Typography>
            </>
          )}

          {importPhase === 'importing' && (
            <ImportProgressSteps progress={importProgress} />
          )}

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

          {importPhase === 'error' && importError && (
            <MuiAlert severity="error">
              <AlertTitle>Import failed</AlertTitle>
              {importError}
            </MuiAlert>
          )}
        </DialogContent>

        {importPhase === 'preview' && (
          <DialogActions>
            <Button onClick={handleImportDialogClose}>Cancel</Button>
            <Button variant="contained" onClick={handleImportConfirm}>Import</Button>
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
