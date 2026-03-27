'use client';

import React, { useState, useEffect } from 'react';
import Box from '@mui/material/Box';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import MuiAlert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
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
import AddOutlined from '@mui/icons-material/AddOutlined';
import SyncOutlined from '@mui/icons-material/SyncOutlined';
import WarningOutlined from '@mui/icons-material/WarningOutlined';
import type { AuroraCredentialStatus } from '@/app/api/internal/aurora-credentials/route';
import type { UnsyncedCounts } from '@/app/api/internal/aurora-credentials/unsynced/route';
import styles from './aurora-credentials-section.module.css';

interface BoardUnsyncedCounts {
  ascents: number;
  climbs: number;
}

interface BoardCredentialCardProps {
  boardType: 'kilter' | 'tension';
  credential: AuroraCredentialStatus | null;
  unsyncedCounts: BoardUnsyncedCounts;
  onAdd: () => void;
  onRemove: () => void;
  isRemoving: boolean;
}

function BoardCredentialCard({
  boardType,
  credential,
  unsyncedCounts,
  onAdd,
  onRemove,
  isRemoving,
}: BoardCredentialCardProps) {
  const boardName = boardType.charAt(0).toUpperCase() + boardType.slice(1);
  const totalUnsynced = unsyncedCounts.ascents + unsyncedCounts.climbs;

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
          <Typography variant="body2" component="span" color="text.secondary" className={styles.notConnectedText}>
            Not connected. Link your {boardName} account to import your Aurora data.
          </Typography>
          <Button variant="contained" startIcon={<AddOutlined />} onClick={onAdd} fullWidth>
            Link {boardName} Account
          </Button>
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
            fullWidth
          >
            Unlink Account
          </Button>
        </ConfirmPopover>
      </CardContent>
    </Card>
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

      showMessage(`${selectedBoard.charAt(0).toUpperCase() + selectedBoard.slice(1)} account linked successfully`, 'success');
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

  const getCredentialForBoard = (boardType: 'kilter' | 'tension') => {
    return credentials.find((c) => c.boardType === boardType) || null;
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
          <Typography variant="h5">Tension Board Account</Typography>
          <Typography variant="body2" component="span" color="text.secondary" className={styles.sectionDescription}>
            Link your Tension board account to import your Aurora data to Boardsesh.
            We'll automatically sync your logbook, ascents, and climbs FROM Aurora every 6 hours.
            Data created in Boardsesh stays local and does not sync back to Aurora.
          </Typography>

          <Stack spacing={2} className={styles.cardsContainer}>
            <BoardCredentialCard
              boardType="tension"
              credential={getCredentialForBoard('tension')}
              unsyncedCounts={unsyncedCounts?.tension ?? { ascents: 0, climbs: 0 }}
              onAdd={() => handleAddClick('tension')}
              onRemove={() => handleRemove('tension')}
              isRemoving={removingBoard === 'tension'}
            />
          </Stack>
        </CardContent>
      </Card>

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
          Your credentials are encrypted and securely stored. Data syncs every 6 hours.
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
    </>
  );
}
