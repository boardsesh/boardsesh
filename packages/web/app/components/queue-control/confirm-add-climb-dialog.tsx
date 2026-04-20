'use client';

import React from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import type { BoardConfig } from '@boardsesh/shared-schema';

export type ConfirmAddReason = 'new_config' | 'larger_size';

export type ConfirmAddChoice = 'switch' | 'add' | 'cancel';

interface ConfirmAddClimbDialogProps {
  open: boolean;
  reason: ConfirmAddReason | null;
  incoming: BoardConfig | null;
  onChoose: (choice: ConfirmAddChoice) => void;
}

function formatBoardLabel(config: BoardConfig | null): string {
  if (!config) return '';
  const name = config.boardName.charAt(0).toUpperCase() + config.boardName.slice(1);
  return `${name}`;
}

export default function ConfirmAddClimbDialog({
  open,
  reason,
  incoming,
  onChoose,
}: ConfirmAddClimbDialogProps) {
  const boardLabel = formatBoardLabel(incoming);

  const headline =
    reason === 'larger_size'
      ? 'This climb is for a bigger board size'
      : 'This climb is on a different board';

  const body =
    reason === 'larger_size'
      ? `This climb was set for a larger ${boardLabel} than what you've got queued. Some holds may not be on your smaller boards.`
      : `You're about to add a climb from ${boardLabel}. Keep both in your queue or switch to just this board?`;

  return (
    <Dialog
      open={open}
      onClose={() => onChoose('cancel')}
      aria-labelledby="confirm-add-climb-title"
      aria-describedby="confirm-add-climb-body"
      maxWidth="xs"
      fullWidth
    >
      <DialogTitle id="confirm-add-climb-title">{headline}</DialogTitle>
      <DialogContent>
        <DialogContentText id="confirm-add-climb-body">{body}</DialogContentText>
      </DialogContent>
      <DialogActions>
        <Stack direction="column" spacing={1} sx={{ width: '100%' }}>
          <Button
            variant="contained"
            color="primary"
            onClick={() => onChoose('add')}
            fullWidth
          >
            Add to current queue
          </Button>
          <Button
            variant="outlined"
            onClick={() => onChoose('switch')}
            fullWidth
          >
            Switch to that board
          </Button>
          <Button
            variant="text"
            onClick={() => onChoose('cancel')}
            fullWidth
          >
            Cancel
          </Button>
        </Stack>
      </DialogActions>
    </Dialog>
  );
}
