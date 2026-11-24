'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import MuiLink from '@mui/material/Link';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { boardSetupSummary } from '@boardsesh/board-config';
import { SETUP_CHANGE_REVIEW_DAYS_AFTER_UNDO } from '@boardsesh/directory-moderation';
import type { BoardSetupChange, BoardSetupChangeState } from '@boardsesh/shared-schema';
import {
  GET_ADMIN_BOARD_SETUP_CHANGES,
  UNDO_BOARD_SETUP_CHANGE,
  type GetAdminBoardSetupChangesQueryResponse,
  type GetAdminBoardSetupChangesQueryVariables,
  type UndoBoardSetupChangeMutationResponse,
  type UndoBoardSetupChangeMutationVariables,
} from '@boardsesh/graphql/operations';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { refreshAccessToken } from '@/app/lib/auth/browser-access-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { relativeTimeFormatter } from '@/app/lib/relative-time';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import LocaleLink from '@/app/components/i18n/locale-link';
import { themeTokens } from '@/app/theme/theme-config';
import {
  SETUP_CHANGES_PAGE_SIZE,
  appendSetupChanges,
  canUndoSetupChange,
  setupChangeBoardHref,
  setupChangeGymHref,
  setupUndoOutcome,
  type SetupUndoOutcome,
} from './board-setup-changes-logic';

const linkSx = { minHeight: 44, display: 'inline-flex', alignItems: 'center', overflowWrap: 'anywhere' } as const;

/**
 * "Setup changes by climbers" at `/admin/board-reports`
 * (docs/product/directory-reports.md, "Undo"): every change a climber's
 * suggested setup made to a board at a gym nobody runs, newest first. Each row
 * links the board and its gym, says the setup before and after, who made the
 * change and when, and where it stands: Live, Undone, or Changed since (the
 * board changed again, so it can't be put back).
 *
 * **Undo** asks first, then sends `undoBoardSetupChange`. The server only puts
 * the old setup back while the board still has the climber's. Whatever comes
 * back (put back, someone put it back first, changed since, a failure), a
 * message says so and the first page is read again, so every row shows where
 * it stands now.
 *
 * Without a token (the ws-auth read failed) the list can't load: the panel
 * says so and Retry asks for a token, rather than spinning, and an Undo says it
 * didn't go through.
 */
export default function BoardSetupChangesPanel() {
  const { t, i18n } = useTranslation('admin');
  const { token, isLoading: tokenLoading } = useWsAuthToken();
  const { showMessage } = useSnackbar();
  const [changes, setChanges] = useState<BoardSetupChange[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [confirm, setConfirm] = useState<BoardSetupChange | null>(null);
  const [undoingEventId, setUndoingEventId] = useState<string | null>(null);
  // One undo at a time, even from two taps in the same frame.
  const undoingRef = useRef(false);
  const requestRef = useRef(0);
  // Read through a ref so a token rotation doesn't reload the list and drop pages already loaded.
  const tokenRef = useRef(token);
  useEffect(() => {
    tokenRef.current = token;
  }, [token]);
  const hasToken = Boolean(token);
  // The token read gave up: nothing will load until a new one arrives.
  const tokenUnavailable = !token && !tokenLoading;
  const [nowMs] = useState(() => Date.now());
  const relativeTime = useMemo(() => relativeTimeFormatter(i18n.language, nowMs), [i18n.language, nowMs]);

  const fetchPage = useCallback(async (after: string | null) => {
    const currentToken = tokenRef.current;
    if (!currentToken) return;
    const request = ++requestRef.current;
    setLoading(true);
    setLoadFailed(false);
    try {
      const response = await createGraphQLHttpClient(currentToken).request<
        GetAdminBoardSetupChangesQueryResponse,
        GetAdminBoardSetupChangesQueryVariables
      >(GET_ADMIN_BOARD_SETUP_CHANGES, { first: SETUP_CHANGES_PAGE_SIZE, after: after ?? undefined });
      if (request !== requestRef.current) return;
      const page = response.adminBoardSetupChanges;
      setChanges((previous) => (after ? appendSetupChanges(previous, page.changes) : page.changes));
      setNextCursor(page.nextCursor ?? null);
    } catch (error) {
      console.error('[BoardSetupChangesPanel] Failed to load setup changes:', error);
      if (request === requestRef.current) setLoadFailed(true);
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!hasToken) return;
    void fetchPage(null);
    return () => {
      requestRef.current += 1;
    };
  }, [fetchPage, hasToken]);

  const retryLoad = () => {
    // No token to read with: ask for one; the list loads once it arrives.
    if (!tokenRef.current) void refreshAccessToken();
    else void fetchPage(changes.length > 0 ? nextCursor : null);
  };

  const undo = async (change: BoardSetupChange) => {
    if (undoingRef.current) return;
    const currentToken = tokenRef.current;
    if (!currentToken) {
      showMessage(t('boardReports.snackbar.failed'), 'error');
      void refreshAccessToken();
      return;
    }
    undoingRef.current = true;
    setUndoingEventId(change.eventId);
    try {
      let outcome: SetupUndoOutcome;
      try {
        await createGraphQLHttpClient(currentToken).request<
          UndoBoardSetupChangeMutationResponse,
          UndoBoardSetupChangeMutationVariables
        >(UNDO_BOARD_SETUP_CHANGE, { eventId: change.eventId });
        outcome = setupUndoOutcome({ ok: true });
      } catch (error) {
        outcome = setupUndoOutcome({ ok: false, error });
        if (outcome === 'failed') console.error('[BoardSetupChangesPanel] Undo failed:', error);
      }
      switch (outcome) {
        case 'undone':
          showMessage(t('boardReports.setupChanges.undone'), 'success');
          break;
        case 'already_undone':
          showMessage(t('boardReports.setupChanges.alreadyUndone'), 'info');
          break;
        case 'changed_since':
          showMessage(t('boardReports.setupChanges.changedSinceError'), 'warning');
          break;
        case 'failed':
          showMessage(t('boardReports.snackbar.failed'), 'error');
          break;
      }
      // Whatever happened, read the first page again: it says where every change stands now.
      await fetchPage(null);
    } finally {
      undoingRef.current = false;
      setUndoingEventId(null);
    }
  };

  const listFailed = loadFailed || tokenUnavailable;

  const stateLabel = (state: BoardSetupChangeState): string => {
    switch (state) {
      case 'LIVE':
        return t('boardReports.setupChanges.state.live');
      case 'UNDONE':
        return t('boardReports.setupChanges.state.undone');
      case 'CHANGED_SINCE':
        return t('boardReports.setupChanges.state.changedSince');
    }
  };

  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2, maxWidth: '68ch' }}>
        {t('boardReports.setupChanges.description')}
      </Typography>

      {listFailed && (
        <Alert
          severity="error"
          sx={{ mb: 2 }}
          action={
            <Button color="inherit" size="small" onClick={retryLoad} sx={{ textTransform: 'none' }}>
              {t('boardReports.retry')}
            </Button>
          }
        >
          {t('boardReports.setupChanges.error')}
        </Alert>
      )}

      {loading && changes.length === 0 && !tokenUnavailable ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress />
        </Box>
      ) : changes.length === 0 && !listFailed ? (
        <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
          {t('boardReports.setupChanges.empty')}
        </Typography>
      ) : (
        <Stack spacing={1.5}>
          {changes.map((change) => (
            <Paper key={change.eventId} variant="outlined" sx={{ p: 2 }} data-testid={`setup-change-${change.eventId}`}>
              <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
                <MuiLink
                  component={LocaleLink}
                  href={setupChangeBoardHref(change.board)}
                  sx={{ ...linkSx, fontWeight: themeTokens.typography.fontWeight.semibold }}
                >
                  {change.board.name}
                </MuiLink>
                {change.gym && (
                  <>
                    <Typography component="span" color="text.secondary" aria-hidden>
                      ·
                    </Typography>
                    <MuiLink component={LocaleLink} href={setupChangeGymHref(change.gym)} sx={linkSx}>
                      {change.gym.name}
                    </MuiLink>
                  </>
                )}
                <Chip
                  size="small"
                  variant={change.state === 'LIVE' ? 'filled' : 'outlined'}
                  color={change.state === 'LIVE' ? 'success' : 'default'}
                  label={stateLabel(change.state)}
                />
              </Box>

              <Box
                component="dl"
                sx={{ m: 0, mt: 1, display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 1.5 }}
              >
                <Typography component="dt" variant="body2" color="text.secondary">
                  {t('boardReports.setupChanges.before')}
                </Typography>
                <Typography component="dd" variant="body2" sx={{ m: 0, overflowWrap: 'anywhere' }}>
                  {boardSetupSummary(change.board.boardType, change.before)}
                </Typography>
                <Typography component="dt" variant="body2" color="text.secondary">
                  {t('boardReports.setupChanges.after')}
                </Typography>
                <Typography component="dd" variant="body2" sx={{ m: 0, overflowWrap: 'anywhere' }}>
                  {boardSetupSummary(change.board.boardType, change.after)}
                </Typography>
              </Box>

              <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                {t('boardReports.setupChanges.byLine', {
                  name: change.climberDisplayName || t('boardReports.reporterUnknown'),
                  when: relativeTime(change.createdAt),
                })}
              </Typography>

              {canUndoSetupChange(change) && (
                <Box sx={{ mt: 1.5 }}>
                  <Button
                    size="small"
                    variant="outlined"
                    onClick={() => setConfirm(change)}
                    disabled={undoingEventId !== null}
                    loading={undoingEventId === change.eventId}
                    sx={{ textTransform: 'none', minHeight: 44 }}
                  >
                    {t('boardReports.setupChanges.undo')}
                  </Button>
                </Box>
              )}
            </Paper>
          ))}
        </Stack>
      )}

      {nextCursor && (
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
          <Button onClick={() => void fetchPage(nextCursor)} disabled={loading} sx={{ textTransform: 'none' }}>
            {loading ? <CircularProgress size={16} /> : t('boardReports.loadMore')}
          </Button>
        </Box>
      )}

      <Dialog open={confirm !== null} onClose={() => setConfirm(null)} maxWidth="xs" fullWidth>
        {confirm && (
          <>
            <DialogTitle>{t('boardReports.setupChanges.confirmTitle', { board: confirm.board.name })}</DialogTitle>
            <DialogContent>
              <DialogContentText>
                {t('boardReports.setupChanges.confirmBody', {
                  setup: boardSetupSummary(confirm.board.boardType, confirm.before),
                  days: SETUP_CHANGE_REVIEW_DAYS_AFTER_UNDO,
                })}
              </DialogContentText>
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setConfirm(null)} sx={{ textTransform: 'none' }}>
                {t('boardReports.confirm.cancel')}
              </Button>
              <Button
                variant="contained"
                onClick={() => {
                  const change = confirm;
                  setConfirm(null);
                  void undo(change);
                }}
                sx={{ textTransform: 'none' }}
              >
                {t('boardReports.setupChanges.undo')}
              </Button>
            </DialogActions>
          </>
        )}
      </Dialog>
    </Box>
  );
}
