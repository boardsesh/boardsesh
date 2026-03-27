'use client';

import React, { useState, useRef, useCallback } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import LinearProgress from '@mui/material/LinearProgress';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Chip from '@mui/material/Chip';
import FileUploadOutlined from '@mui/icons-material/FileUploadOutlined';
import CheckCircleOutlined from '@mui/icons-material/CheckCircleOutlined';
import ErrorOutlined from '@mui/icons-material/ErrorOutlined';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';

/**
 * Get the backend HTTP URL from the WebSocket URL
 */
function getBackendHttpUrl(): string | null {
  const wsUrl = process.env.NEXT_PUBLIC_WS_URL;
  if (!wsUrl) return null;

  try {
    const url = new URL(wsUrl);
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    url.pathname = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

interface ImportJobStatus {
  id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  boardType: string;
  totalItems: number;
  processedItems: number;
  failedItems: number;
  errors: string[];
  result: {
    followsImported?: number;
    circuitsImported?: number;
    likesImported?: number;
    attemptsImported?: number;
    ascentsImported?: number;
    climbsImported?: number;
    skipped?: number;
  } | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export default function ImportDataSection() {
  const [boardType, setBoardType] = useState<'kilter' | 'tension'>('kilter');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<ImportJobStatus | null>(null);
  const [polling, setPolling] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { token: authToken } = useWsAuthToken();
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const stopPolling = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    setPolling(false);
  }, []);

  const pollJobStatus = useCallback(async (jobId: string) => {
    const backendUrl = getBackendHttpUrl();
    if (!backendUrl || !authToken) return;

    try {
      const res = await fetch(`${backendUrl}/api/import/status?jobId=${jobId}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });

      if (!res.ok) return;

      const data: ImportJobStatus = await res.json();
      setJobStatus(data);

      if (data.status === 'completed' || data.status === 'failed') {
        stopPolling();
      }
    } catch {
      // Silently retry on next poll
    }
  }, [authToken, stopPolling]);

  const startPolling = useCallback((jobId: string) => {
    setPolling(true);
    // Poll immediately, then every 2 seconds
    pollJobStatus(jobId);
    pollIntervalRef.current = setInterval(() => pollJobStatus(jobId), 2000);
  }, [pollJobStatus]);

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    // Reset state
    setError(null);
    setJobStatus(null);
    stopPolling();

    // Validate file type
    if (!file.name.endsWith('.json')) {
      setError('Please select a JSON file');
      return;
    }

    if (file.size > 50 * 1024 * 1024) {
      setError('File size must be less than 50MB');
      return;
    }

    const backendUrl = getBackendHttpUrl();
    if (!backendUrl) {
      setError('Backend URL not configured');
      return;
    }

    if (!authToken) {
      setError('Not authenticated');
      return;
    }

    setUploading(true);

    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('boardType', boardType);

      const res = await fetch(`${backendUrl}/api/import`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
        body: formData,
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Upload failed');
        return;
      }

      // Start polling for job status
      startPolling(data.jobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const progress = jobStatus && jobStatus.totalItems > 0
    ? (jobStatus.processedItems / jobStatus.totalItems) * 100
    : 0;

  const isProcessing = jobStatus?.status === 'pending' || jobStatus?.status === 'processing';
  const isCompleted = jobStatus?.status === 'completed';
  const isFailed = jobStatus?.status === 'failed';

  return (
    <Card
      sx={{
        background: 'var(--semantic-surface)',
        border: '1px solid var(--neutral-200)',
        borderRadius: 'var(--radius-lg)',
      }}
    >
      <CardContent>
        <Stack spacing={2}>
          <Typography variant="h6" sx={{ fontWeight: 600, color: 'var(--semantic-text-primary)' }}>
            Import Aurora Data
          </Typography>

          <Typography variant="body2" sx={{ color: 'var(--semantic-text-secondary)' }}>
            Import your climbing data from an Aurora board app export (JSON format).
            This will import your ascents, attempts, likes, and circuits.
          </Typography>

          <Box>
            <Typography variant="body2" sx={{ mb: 1, color: 'var(--semantic-text-secondary)' }}>
              Board Type
            </Typography>
            <ToggleButtonGroup
              value={boardType}
              exclusive
              onChange={(_, value) => value && setBoardType(value)}
              size="small"
            >
              <ToggleButton value="kilter">Kilter</ToggleButton>
              <ToggleButton value="tension">Tension</ToggleButton>
            </ToggleButtonGroup>
          </Box>

          <Box>
            <input
              type="file"
              accept=".json"
              ref={fileInputRef}
              onChange={handleFileSelect}
              style={{ display: 'none' }}
            />
            <Button
              variant="outlined"
              startIcon={uploading ? <CircularProgress size={16} /> : <FileUploadOutlined />}
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading || isProcessing}
            >
              {uploading ? 'Uploading...' : 'Select JSON File'}
            </Button>
          </Box>

          {error && (
            <Alert severity="error" onClose={() => setError(null)}>
              {error}
            </Alert>
          )}

          {jobStatus && (
            <Box>
              {isProcessing && (
                <Stack spacing={1}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <CircularProgress size={16} />
                    <Typography variant="body2" sx={{ color: 'var(--semantic-text-secondary)' }}>
                      {jobStatus.status === 'pending' ? 'Waiting to process...' : 'Processing...'}
                    </Typography>
                  </Box>
                  <LinearProgress variant="determinate" value={progress} />
                  <Typography variant="caption" sx={{ color: 'var(--semantic-text-tertiary)' }}>
                    {jobStatus.processedItems} / {jobStatus.totalItems} items
                  </Typography>
                </Stack>
              )}

              {isCompleted && (
                <Alert
                  severity="success"
                  icon={<CheckCircleOutlined />}
                >
                  <Typography variant="body2" sx={{ fontWeight: 600, mb: 1 }}>
                    Import completed
                  </Typography>
                  <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                    {jobStatus.result?.ascentsImported != null && jobStatus.result.ascentsImported > 0 && (
                      <Chip label={`${jobStatus.result.ascentsImported} ascents`} size="small" color="success" variant="outlined" />
                    )}
                    {jobStatus.result?.attemptsImported != null && jobStatus.result.attemptsImported > 0 && (
                      <Chip label={`${jobStatus.result.attemptsImported} attempts`} size="small" color="success" variant="outlined" />
                    )}
                    {jobStatus.result?.likesImported != null && jobStatus.result.likesImported > 0 && (
                      <Chip label={`${jobStatus.result.likesImported} likes`} size="small" color="success" variant="outlined" />
                    )}
                    {jobStatus.result?.circuitsImported != null && jobStatus.result.circuitsImported > 0 && (
                      <Chip label={`${jobStatus.result.circuitsImported} circuits`} size="small" color="success" variant="outlined" />
                    )}
                  </Stack>
                  {jobStatus.failedItems > 0 && (
                    <Typography variant="caption" sx={{ mt: 1, display: 'block', color: 'var(--semantic-text-secondary)' }}>
                      {jobStatus.failedItems} items could not be imported (e.g., climbs not found in database)
                    </Typography>
                  )}
                </Alert>
              )}

              {isFailed && (
                <Alert
                  severity="error"
                  icon={<ErrorOutlined />}
                >
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    Import failed
                  </Typography>
                  {jobStatus.errors && jobStatus.errors.length > 0 && (
                    <Typography variant="caption" sx={{ mt: 0.5, display: 'block' }}>
                      {jobStatus.errors[0]}
                    </Typography>
                  )}
                </Alert>
              )}
            </Box>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
}
