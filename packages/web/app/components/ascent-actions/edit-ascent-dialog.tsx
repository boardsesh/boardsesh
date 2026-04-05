'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import ToggleButton from '@mui/material/ToggleButton';
import Rating from '@mui/material/Rating';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import CircularProgress from '@mui/material/CircularProgress';
import type { TickStatus } from '@/app/hooks/use-logbook';

export interface EditAscentValues {
  status: TickStatus;
  attemptCount: number;
  quality: number | null;
  comment: string;
}

interface EditAscentDialogProps {
  open: boolean;
  onClose: () => void;
  onSave: (values: EditAscentValues) => void;
  saving?: boolean;
  initialValues: EditAscentValues;
}

export default function EditAscentDialog({
  open,
  onClose,
  onSave,
  saving = false,
  initialValues,
}: EditAscentDialogProps) {
  const [status, setStatus] = useState<TickStatus>(initialValues.status);
  const [attemptCount, setAttemptCount] = useState(initialValues.attemptCount);
  const [quality, setQuality] = useState<number | null>(initialValues.quality);
  const [comment, setComment] = useState(initialValues.comment);

  // Reset form when dialog opens with new values
  useEffect(() => {
    if (open) {
      setStatus(initialValues.status);
      setAttemptCount(initialValues.attemptCount);
      setQuality(initialValues.quality);
      setComment(initialValues.comment);
    }
    // Destructure to avoid re-firing when parent creates a new object with same values
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialValues.status, initialValues.attemptCount, initialValues.quality, initialValues.comment]);

  const handleStatusChange = useCallback((_: React.MouseEvent<HTMLElement>, newStatus: TickStatus | null) => {
    if (!newStatus) return;
    setStatus(newStatus);
    // Auto-adjust attempt count for flash
    if (newStatus === 'flash') {
      setAttemptCount(1);
    } else if (newStatus === 'send' && attemptCount <= 1) {
      setAttemptCount(2);
    }
    // Clear quality for attempts
    if (newStatus === 'attempt') {
      setQuality(null);
    }
  }, [attemptCount]);

  const handleSave = useCallback(() => {
    onSave({ status, attemptCount, quality, comment });
  }, [onSave, status, attemptCount, quality, comment]);

  const isAscent = status === 'flash' || status === 'send';

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Edit ascent</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <div>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
              Result
            </Typography>
            <ToggleButtonGroup
              value={status}
              exclusive
              onChange={handleStatusChange}
              size="small"
              fullWidth
            >
              <ToggleButton value="flash">Flash</ToggleButton>
              <ToggleButton value="send">Send</ToggleButton>
              <ToggleButton value="attempt">Attempt</ToggleButton>
            </ToggleButtonGroup>
          </div>

          {status !== 'flash' && (
            <TextField
              label="Attempts"
              type="number"
              size="small"
              fullWidth
              value={attemptCount}
              onChange={(e) => setAttemptCount(Math.max(status === 'send' ? 2 : 1, Number(e.target.value)))}
              slotProps={{ htmlInput: { min: status === 'send' ? 2 : 1, max: 999 } }}
            />
          )}

          {isAscent && (
            <div>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
                Quality
              </Typography>
              <Rating
                value={quality}
                onChange={(_, newValue) => setQuality(newValue)}
                max={5}
              />
            </div>
          )}

          <TextField
            label="Comment"
            size="small"
            fullWidth
            multiline
            minRows={2}
            maxRows={4}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            slotProps={{ htmlInput: { maxLength: 2000 } }}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={handleSave}
          disabled={saving}
          startIcon={saving ? <CircularProgress size={16} /> : undefined}
        >
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}
