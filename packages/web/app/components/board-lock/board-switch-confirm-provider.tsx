'use client';

import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import type { BoardDetails, BoardRouteIdentity } from '@/app/lib/types';
import type { BoardLockReason } from './use-active-board-lock';
import { formatBoardDisplayName } from '@/app/lib/string-utils';

type ConfirmArgs = {
  reason: BoardLockReason;
  lockedBoard: BoardDetails;
  target: BoardRouteIdentity | BoardDetails;
  onConfirmed: () => void;
};

type BoardSwitchConfirmContextValue = {
  confirmBoardSwitch: (args: ConfirmArgs) => void;
};

const BoardSwitchConfirmContext = createContext<BoardSwitchConfirmContextValue | null>(null);

/**
 * Returns the board-switch confirmation context, or `null` when the
 * provider isn't mounted. `useBoardSwitchGuard` falls back to an
 * immediate call-through in that case so tests and non-app surfaces
 * (Storybook, isolated components) don't need to wrap their render
 * tree in the provider.
 */
export function useBoardSwitchConfirm(): BoardSwitchConfirmContextValue | null {
  return useContext(BoardSwitchConfirmContext);
}

function formatBoardLabel(board: BoardDetails | BoardRouteIdentity): string {
  const parts = [formatBoardDisplayName(board.board_name)];
  if (board.layout_name) parts.push(board.layout_name);
  if (board.size_name) parts.push(board.size_name);
  return parts.join(' · ');
}

type DialogState = {
  open: boolean;
  reason: BoardLockReason;
  lockedLabel: string;
  targetLabel: string;
};

export function BoardSwitchConfirmProvider({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation('boards');
  const [state, setState] = useState<DialogState | null>(null);
  // Hold onConfirmed in a ref so handlers never read a stale closure and
  // the render doesn't need to re-run when the callback changes.
  const pendingConfirmRef = useRef<(() => void) | null>(null);

  const confirmBoardSwitch = useCallback((args: ConfirmArgs) => {
    pendingConfirmRef.current = args.onConfirmed;
    setState({
      open: true,
      reason: args.reason,
      lockedLabel: formatBoardLabel(args.lockedBoard),
      targetLabel: formatBoardLabel(args.target),
    });
  }, []);

  const handleCancel = useCallback(() => {
    pendingConfirmRef.current = null;
    setState((prev) => (prev ? { ...prev, open: false } : prev));
  }, []);

  const handleConfirm = useCallback(() => {
    const callback = pendingConfirmRef.current;
    pendingConfirmRef.current = null;
    setState((prev) => (prev ? { ...prev, open: false } : prev));
    callback?.();
  }, []);

  const handleExited = useCallback(() => {
    setState(null);
  }, []);

  const value = useMemo<BoardSwitchConfirmContextValue>(() => ({ confirmBoardSwitch }), [confirmBoardSwitch]);

  const title =
    state?.reason === 'session' ? t('boardSwitchConfirm.session.title') : t('boardSwitchConfirm.connection.title');
  const body =
    state?.reason === 'session'
      ? t('boardSwitchConfirm.session.body', { lockedLabel: state?.lockedLabel, targetLabel: state?.targetLabel })
      : t('boardSwitchConfirm.connection.body', { lockedLabel: state?.lockedLabel, targetLabel: state?.targetLabel });

  return (
    <BoardSwitchConfirmContext.Provider value={value}>
      {children}
      <Dialog
        open={state?.open ?? false}
        onClose={handleCancel}
        TransitionProps={{ onExited: handleExited }}
        maxWidth="xs"
        fullWidth
        aria-labelledby="board-switch-confirm-title"
      >
        <DialogTitle id="board-switch-confirm-title">{title}</DialogTitle>
        <DialogContent>
          <DialogContentText>{body}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCancel}>{t('boardSwitchConfirm.stay')}</Button>
          <Button variant="contained" onClick={handleConfirm} autoFocus>
            {t('boardSwitchConfirm.switch')}
          </Button>
        </DialogActions>
      </Dialog>
    </BoardSwitchConfirmContext.Provider>
  );
}
