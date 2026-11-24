'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'next/navigation';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Alert from '@mui/material/Alert';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogActions from '@mui/material/DialogActions';
import MuiLink from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import { REPORT_NOTE_MAX_LENGTH, normalizeReportNote } from '@boardsesh/directory-moderation';
import type {
  DirectoryReport,
  DirectoryReportRecipient,
  DirectoryReportStatus,
  DirectoryReportTargetKind,
} from '@boardsesh/shared-schema';
import {
  DELETE_BOARD,
  DETACH_BOARD_FROM_GYM,
  GET_ADMIN_DIRECTORY_REPORTS,
  RESOLVE_DIRECTORY_REPORT,
  UPDATE_GYM,
  type DeleteBoardMutationResponse,
  type DeleteBoardMutationVariables,
  type DetachBoardFromGymMutationResponse,
  type DetachBoardFromGymMutationVariables,
  type GetAdminDirectoryReportsQueryResponse,
  type GetAdminDirectoryReportsQueryVariables,
  type ResolveDirectoryReportMutationResponse,
  type ResolveDirectoryReportMutationVariables,
  type UpdateGymMutationResponse,
  type UpdateGymMutationVariables,
} from '@boardsesh/graphql/operations';
import {
  isBoardNotAtGymError,
  isDirectoryReportClosedError,
  isSystemBoardDeleteInsteadError,
} from '@boardsesh/graphql/errors';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { useLocaleRouter, usePathnameWithoutLocale } from '@/app/lib/i18n/use-locale-router';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import LocaleLink from '@/app/components/i18n/locale-link';
import { reportReasonLabel } from '@/app/components/directory-reports/report-copy';
import { themeTokens } from '@/app/theme/theme-config';
import BoardSetupChangesPanel from './board-setup-changes-panel';
import { boardReportsTabHref, type BoardReportsTab } from './board-setup-changes-logic';
import {
  adminActionsFor,
  orderAdminReports,
  planAdminAction,
  reportAgeDays,
  type AdminReportAction,
  type AdminReportStep,
} from './board-reports-actions';

const PAGE_SIZE = 50;

const STATUS_FILTERS: readonly DirectoryReportStatus[] = [
  'escalated',
  'open',
  'fixed',
  'removed',
  'deleted',
  'kept',
  'merged',
];

type KindFilter = 'all' | DirectoryReportTargetKind;

type PendingConfirm = { report: DirectoryReport; action: AdminReportAction };

/**
 * `/admin/board-reports`: the report queue, and "Setup changes by climbers",
 * the changes climbers' suggested setups made to boards at gyms nobody runs,
 * each one an admin can undo (docs/product/directory-reports.md).
 *
 * The open tab is written back to the URL (`?tab=setup-changes`) with
 * `router.replace`, so a reload or a shared link opens the same tab without a
 * history entry per switch.
 */
export default function BoardReportsPanel({
  highlightReportUuid,
  initialTab = 'reports',
}: {
  highlightReportUuid: string | null;
  /** `?tab=setup-changes` opens on the setup changes. */
  initialTab?: BoardReportsTab;
}) {
  const { t } = useTranslation('admin');
  const router = useLocaleRouter();
  const pathname = usePathnameWithoutLocale();
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<BoardReportsTab>(initialTab);
  const changeTab = (next: BoardReportsTab) => {
    setTab(next);
    router.replace(boardReportsTabHref(pathname, searchParams.toString(), next), { scroll: false });
  };
  return (
    <Box>
      <Tabs
        value={tab}
        onChange={(_event, value: BoardReportsTab) => changeTab(value)}
        variant="scrollable"
        allowScrollButtonsMobile
        sx={{ mb: 2, borderBottom: 1, borderColor: 'divider' }}
      >
        <Tab value="reports" label={t('boardReports.tabs.reports')} sx={{ textTransform: 'none', minHeight: 44 }} />
        <Tab
          value="setup-changes"
          label={t('boardReports.tabs.setupChanges')}
          sx={{ textTransform: 'none', minHeight: 44 }}
        />
      </Tabs>
      {tab === 'reports' ? (
        <DirectoryReportsQueue highlightReportUuid={highlightReportUuid} />
      ) : (
        <BoardSetupChangesPanel />
      )}
    </Box>
  );
}

/**
 * The Boardsesh admin queue for board and gym reports
 * (docs/product/directory-reports.md): reports nobody else can act on (a synced
 * board at a gym nobody runs, a wrong place, most gym reports) and any report
 * still open after 14 days. Admins see who reported, which creators and staff
 * never do.
 */
function DirectoryReportsQueue({ highlightReportUuid }: { highlightReportUuid: string | null }) {
  const { t, i18n } = useTranslation('admin');
  const { t: tBoards } = useTranslation('boards');
  const { token } = useWsAuthToken();
  const { showMessage } = useSnackbar();
  const [status, setStatus] = useState<DirectoryReportStatus>('escalated');
  const [kind, setKind] = useState<KindFilter>('all');
  const [reports, setReports] = useState<DirectoryReport[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busyReportUuid, setBusyReportUuid] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const [keepNote, setKeepNote] = useState('');
  const requestRef = useRef(0);
  // Read through a ref so a token rotation doesn't reload the list and drop pages already loaded.
  const tokenRef = useRef(token);
  useEffect(() => {
    tokenRef.current = token;
  }, [token]);
  const hasToken = Boolean(token);
  const [now] = useState(() => new Date());

  const fetchPage = useCallback(
    async (after: string | null) => {
      const currentToken = tokenRef.current;
      if (!currentToken) return;
      const request = ++requestRef.current;
      setLoading(true);
      setLoadFailed(false);
      try {
        const response = await createGraphQLHttpClient(currentToken).request<
          GetAdminDirectoryReportsQueryResponse,
          GetAdminDirectoryReportsQueryVariables
        >(GET_ADMIN_DIRECTORY_REPORTS, {
          status,
          targetKind: kind === 'all' ? undefined : kind,
          first: PAGE_SIZE,
          after: after ?? undefined,
        });
        if (request !== requestRef.current) return;
        const page = response.adminDirectoryReports;
        setReports((previous) => (after ? [...previous, ...page.reports] : page.reports));
        setNextCursor(page.nextCursor ?? null);
      } catch (error) {
        console.error('[BoardReportsPanel] Failed to load reports:', error);
        if (request === requestRef.current) setLoadFailed(true);
      } finally {
        if (request === requestRef.current) setLoading(false);
      }
    },
    [status, kind],
  );

  // A new filter starts from an empty list rather than showing the last one under it.
  useEffect(() => {
    if (!hasToken) return;
    setReports([]);
    setNextCursor(null);
    void fetchPage(null);
  }, [fetchPage, hasToken]);

  const ordered = useMemo(() => orderAdminReports(reports), [reports]);

  // The daily digest links one report: bring it into view once it has loaded.
  const highlightedRef = useRef<HTMLDivElement | null>(null);
  const scrolledRef = useRef(false);
  useEffect(() => {
    if (scrolledRef.current || !highlightedRef.current) return;
    scrolledRef.current = true;
    highlightedRef.current.scrollIntoView({ block: 'center' });
  }, [ordered]);

  const runSteps = async (steps: AdminReportStep[], onGymHidden?: () => void) => {
    const client = createGraphQLHttpClient(token);
    for (const step of steps) {
      switch (step.kind) {
        case 'delete_board': {
          const response = await client.request<DeleteBoardMutationResponse, DeleteBoardMutationVariables>(
            DELETE_BOARD,
            { boardUuid: step.boardUuid },
          );
          if (!response.deleteBoard) throw new Error('deleteBoard returned false');
          break;
        }
        case 'detach_board':
          try {
            await client.request<DetachBoardFromGymMutationResponse, DetachBoardFromGymMutationVariables>(
              DETACH_BOARD_FROM_GYM,
              { input: { gymUuid: step.gymUuid, boardUuid: step.boardUuid } },
            );
          } catch (error) {
            // The board already left this gym: the removal is done, so close the report.
            if (!isBoardNotAtGymError(error)) throw error;
          }
          break;
        case 'hide_gym':
          await client.request<UpdateGymMutationResponse, UpdateGymMutationVariables>(UPDATE_GYM, {
            input: { gymUuid: step.gymUuid, isListed: false },
          });
          onGymHidden?.();
          break;
        case 'resolve':
          try {
            await client.request<ResolveDirectoryReportMutationResponse, ResolveDirectoryReportMutationVariables>(
              RESOLVE_DIRECTORY_REPORT,
              { input: { reportUuid: step.reportUuid, outcome: step.outcome, note: step.note } },
            );
          } catch (error) {
            // The action closed it on the server already (a delete or removal does).
            if (!isDirectoryReportClosedError(error)) throw error;
          }
          break;
      }
    }
  };

  const act = async (report: DirectoryReport, action: AdminReportAction, note: string | null) => {
    const steps = planAdminAction(report, action, note);
    if (!steps || !token) return;
    setBusyReportUuid(report.uuid);
    let gymHidden = false;
    try {
      await runSteps(steps, () => {
        gymHidden = true;
      });
      setReports((previous) => previous.filter((candidate) => candidate.uuid !== report.uuid));
      showMessage(successMessage(action), 'success');
    } catch (error) {
      console.error('[BoardReportsPanel] Action failed:', error);
      showMessage(
        isSystemBoardDeleteInsteadError(error)
          ? tBoards('gymBoards.removeSyncedError')
          : gymHidden
            ? t('boardReports.snackbar.hiddenStillOpen')
            : t('boardReports.snackbar.failed'),
        'error',
      );
    } finally {
      setBusyReportUuid(null);
    }
  };

  const successMessage = (action: AdminReportAction): string => {
    switch (action) {
      case 'delete_board':
        return t('boardReports.snackbar.deleted');
      case 'remove_from_gym':
        return t('boardReports.snackbar.removed');
      case 'hide_gym':
        return t('boardReports.snackbar.hidden');
      case 'keep':
        return t('boardReports.snackbar.kept');
    }
  };

  const actionLabel = (action: AdminReportAction): string => {
    switch (action) {
      case 'delete_board':
        return t('boardReports.actions.deleteBoard');
      case 'remove_from_gym':
        return t('boardReports.actions.removeFromGym');
      case 'hide_gym':
        return t('boardReports.actions.hideGym');
      case 'keep':
        return t('boardReports.actions.keep');
    }
  };

  const statusLabel = (value: DirectoryReportStatus): string => {
    switch (value) {
      case 'escalated':
        return t('boardReports.status.escalated');
      case 'open':
        return t('boardReports.status.open');
      case 'fixed':
        return t('boardReports.status.fixed');
      case 'removed':
        return t('boardReports.status.removed');
      case 'deleted':
        return t('boardReports.status.deleted');
      case 'kept':
        return t('boardReports.status.kept');
      case 'merged':
        return t('boardReports.status.merged');
    }
  };

  const recipientLabel = (recipient: DirectoryReportRecipient): string => {
    switch (recipient) {
      case 'creator':
        return t('boardReports.routedTo.creator');
      case 'gym_staff':
        return t('boardReports.routedTo.gymStaff');
      case 'admin':
        return t('boardReports.routedTo.admin');
    }
  };

  const confirmTitle = (pending: PendingConfirm): string => {
    const { report, action } = pending;
    switch (action) {
      case 'delete_board':
        return t('boardReports.confirm.deleteTitle', { board: report.boardName ?? '' });
      case 'remove_from_gym':
        return t('boardReports.confirm.removeTitle', { board: report.boardName ?? '', gym: report.gymName ?? '' });
      case 'hide_gym':
        return t('boardReports.confirm.hideTitle', { gym: report.gymName ?? '' });
      case 'keep':
        return t('boardReports.confirm.keepTitle');
    }
  };

  const confirmBody = (action: AdminReportAction): string => {
    switch (action) {
      case 'delete_board':
        return t('boardReports.confirm.deleteBody');
      case 'remove_from_gym':
        return t('boardReports.confirm.removeBody');
      case 'hide_gym':
        return t('boardReports.confirm.hideBody');
      case 'keep':
        return t('boardReports.confirm.keepBody');
    }
  };

  const formatDate = (iso: string) => new Date(iso).toLocaleDateString(i18n.language, { dateStyle: 'medium' });

  const closeConfirm = () => {
    setConfirm(null);
    setKeepNote('');
  };

  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2, maxWidth: '68ch' }}>
        {t('boardReports.description')}
      </Typography>

      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', mb: 2 }}>
        <TextField
          select
          size="small"
          label={t('boardReports.filters.status')}
          value={status}
          onChange={(event) => setStatus(event.target.value as DirectoryReportStatus)}
          sx={{ minWidth: 200 }}
        >
          {STATUS_FILTERS.map((value) => (
            <MenuItem key={value} value={value}>
              {statusLabel(value)}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          select
          size="small"
          label={t('boardReports.filters.kind')}
          value={kind}
          onChange={(event) => setKind(event.target.value as KindFilter)}
          sx={{ minWidth: 200 }}
        >
          <MenuItem value="all">{t('boardReports.filters.kindAll')}</MenuItem>
          <MenuItem value="board">{t('boardReports.filters.kindBoard')}</MenuItem>
          <MenuItem value="gym">{t('boardReports.filters.kindGym')}</MenuItem>
        </TextField>
      </Box>

      {loadFailed && (
        <Alert
          severity="error"
          sx={{ mb: 2 }}
          action={
            <Button color="inherit" size="small" onClick={() => void fetchPage(null)} sx={{ textTransform: 'none' }}>
              {t('boardReports.retry')}
            </Button>
          }
        >
          {t('boardReports.error')}
        </Alert>
      )}

      {loading && reports.length === 0 ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress />
        </Box>
      ) : ordered.length === 0 && !loadFailed ? (
        <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
          {t('boardReports.empty')}
        </Typography>
      ) : (
        <Stack spacing={1.5}>
          {ordered.map((report) => {
            const highlighted = report.uuid === highlightReportUuid;
            const actions = adminActionsFor(report);
            const ageDays = reportAgeDays(report.createdAt, now);
            return (
              <Paper
                key={report.uuid}
                variant="outlined"
                ref={highlighted ? highlightedRef : undefined}
                sx={{
                  p: 2,
                  borderColor: highlighted ? themeTokens.colors.primary : undefined,
                  borderWidth: highlighted ? 2 : 1,
                }}
              >
                <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center', mb: 0.5 }}>
                  <Chip
                    size="small"
                    variant="outlined"
                    label={report.targetKind === 'gym' ? t('boardReports.kind.gym') : t('boardReports.kind.board')}
                  />
                  <Chip
                    size="small"
                    color="warning"
                    label={reportReasonLabel(report.reason, report.targetKind, tBoards)}
                  />
                  {report.status === 'escalated' && (
                    <Chip
                      size="small"
                      variant="outlined"
                      label={
                        report.routedTo.includes('admin')
                          ? t('boardReports.chips.sentToTeam')
                          : t('boardReports.chips.waited')
                      }
                    />
                  )}
                </Box>

                <Typography sx={{ fontWeight: themeTokens.typography.fontWeight.semibold, overflowWrap: 'anywhere' }}>
                  {report.targetKind === 'board'
                    ? report.gymName
                      ? tBoards('report.boardAtGym', { board: report.boardName ?? '', gym: report.gymName })
                      : (report.boardName ?? '')
                    : (report.gymName ?? '')}
                </Typography>

                <Typography variant="body2" color="text.secondary">
                  {t('boardReports.meta', {
                    count: report.reporterCount,
                    age: ageDays === 0 ? t('boardReports.ageToday') : t('boardReports.ageDays', { count: ageDays }),
                  })}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {t('boardReports.routedToLine', {
                    recipients: report.routedTo.map(recipientLabel).join(', '),
                  })}
                </Typography>

                {(report.duplicateOfBoardName || report.duplicateOfGymName) && (
                  <Typography variant="body2" sx={{ mt: 0.5 }}>
                    {t('boardReports.duplicateOf', {
                      name: report.duplicateOfBoardName ?? report.duplicateOfGymName ?? '',
                    })}
                  </Typography>
                )}

                {report.notes.length > 0 && (
                  <Box component="ul" sx={{ m: 0, mt: 1, pl: 2.5 }}>
                    {report.notes.map((note) => (
                      <Typography
                        component="li"
                        variant="body2"
                        key={`${note.createdAt}:${note.reporter?.userId ?? 'gone'}`}
                        sx={{ overflowWrap: 'anywhere' }}
                      >
                        {t('boardReports.note', {
                          name: note.reporter?.displayName || t('boardReports.reporterUnknown'),
                          note: note.note,
                        })}
                      </Typography>
                    ))}
                  </Box>
                )}

                {report.resolvedAt && (
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                    {t('boardReports.closedOn', {
                      date: formatDate(report.resolvedAt),
                      outcome: statusLabel(report.status),
                    })}
                    {report.resolutionNote ? ` · ${report.resolutionNote}` : ''}
                  </Typography>
                )}

                <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center', mt: 1.5 }}>
                  {actions.map((action) => (
                    <Button
                      key={action}
                      size="small"
                      variant={action === 'keep' ? 'text' : 'outlined'}
                      color={action === 'delete_board' ? 'error' : 'primary'}
                      disabled={busyReportUuid !== null}
                      onClick={() => setConfirm({ report, action })}
                      sx={{ textTransform: 'none' }}
                    >
                      {actionLabel(action)}
                    </Button>
                  ))}
                  {report.targetKind === 'gym' && report.reason === 'duplicate' && (
                    <MuiLink
                      component={LocaleLink}
                      href="/admin/gym-duplicates"
                      sx={{ minHeight: 44, display: 'inline-flex', alignItems: 'center' }}
                    >
                      {t('boardReports.actions.mergeGyms')}
                    </MuiLink>
                  )}
                  {report.gymUuid && (
                    <MuiLink
                      component={LocaleLink}
                      href={`/gym/${report.gymUuid}/manage?tab=boards`}
                      sx={{ minHeight: 44, display: 'inline-flex', alignItems: 'center' }}
                    >
                      {t('boardReports.actions.openGym')}
                    </MuiLink>
                  )}
                </Box>
              </Paper>
            );
          })}
        </Stack>
      )}

      {nextCursor && (
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
          <Button onClick={() => void fetchPage(nextCursor)} disabled={loading} sx={{ textTransform: 'none' }}>
            {loading ? <CircularProgress size={16} /> : t('boardReports.loadMore')}
          </Button>
        </Box>
      )}

      <Dialog open={confirm !== null} onClose={closeConfirm} maxWidth="xs" fullWidth>
        {confirm && (
          <>
            <DialogTitle>{confirmTitle(confirm)}</DialogTitle>
            <DialogContent>
              <DialogContentText>{confirmBody(confirm.action)}</DialogContentText>
              {confirm.action === 'keep' && (
                <TextField
                  label={t('boardReports.confirm.keepNoteLabel')}
                  value={keepNote}
                  onChange={(event) => setKeepNote(event.target.value)}
                  fullWidth
                  multiline
                  minRows={2}
                  maxRows={5}
                  slotProps={{ htmlInput: { maxLength: REPORT_NOTE_MAX_LENGTH } }}
                  sx={{ mt: 2 }}
                />
              )}
            </DialogContent>
            <DialogActions>
              <Button onClick={closeConfirm} sx={{ textTransform: 'none' }}>
                {t('boardReports.confirm.cancel')}
              </Button>
              <Button
                variant="contained"
                color={confirm.action === 'delete_board' ? 'error' : 'primary'}
                onClick={() => {
                  const { report, action } = confirm;
                  const note = action === 'keep' ? normalizeReportNote(keepNote) : null;
                  closeConfirm();
                  void act(report, action, note);
                }}
                sx={{ textTransform: 'none' }}
              >
                {actionLabel(confirm.action)}
              </Button>
            </DialogActions>
          </>
        )}
      </Dialog>
    </Box>
  );
}
