'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import EditOutlined from '@mui/icons-material/EditOutlined';
import LinkOffOutlined from '@mui/icons-material/LinkOffOutlined';
import DeleteOutlined from '@mui/icons-material/DeleteOutlined';
import CheckOutlined from '@mui/icons-material/CheckOutlined';
import {
  REPORT_NOTE_MAX_LENGTH,
  normalizeReportNote,
  setupKey,
  setupMatches,
  suggestedSetupUpdateInput,
} from '@boardsesh/directory-moderation';
import { boardSetupSummary } from '@boardsesh/board-config';
import type { BoardSetup, DirectoryReport, UserBoard } from '@boardsesh/shared-schema';
import {
  GET_BOARD_REPORTS,
  RESOLVE_DIRECTORY_REPORT,
  UPDATE_BOARD,
  type GetBoardReportsQueryResponse,
  type GetBoardReportsQueryVariables,
  type ResolveDirectoryReportMutationResponse,
  type ResolveDirectoryReportMutationVariables,
  type UpdateBoardMutationResponse,
  type UpdateBoardMutationVariables,
} from '@boardsesh/graphql/operations';
import {
  isDirectoryReportClosedError,
  isDuplicateBoardError,
  readDuplicateBoardError,
} from '@boardsesh/graphql/errors';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '@/app/lib/analytics';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { reportReasonLabel } from '@/app/components/directory-reports/report-copy';
import DuplicateBoardConfigDialog, {
  type DuplicateBoardConfig,
} from '@/app/components/board-entity/duplicate-board-config-dialog';
import { themeTokens } from '@/app/theme/theme-config';
import { offersUseThisSetup, reportsToKeep, reviewRows } from './report-review-logic';

type BoardReportReviewDialogProps = {
  /** The reported board, or null when the dialog is closed. */
  board: UserBoard | null;
  gymName: string;
  onClose: () => void;
  /** Fix the setup: open the board editor. Offered when `board.canEdit`. */
  onFix: (board: UserBoard) => void;
  /** Remove from gym: the tab's own confirm. Offered when `board.canRemoveFromGym`. */
  onRemove: (board: UserBoard) => void;
  /** Delete board: the tab's own confirm. Offered when `board.canDelete` and the tab allows deletes. */
  onDelete: (board: UserBoard) => void;
  allowDelete: boolean;
  /** Reports were closed here; the tab re-reads its boards. */
  onResolved: () => void;
};

/**
 * "Climbers flagged this board": the reasons, how many climbers, and what they
 * said, never who (docs/product/directory-reports.md: reporters are anonymous
 * to creators and staff). Then the fixes the viewer has: fix the setup, remove
 * it from the gym, delete it, or keep it as it is with a note for the
 * reporters. The first three close the reports on the server as they happen;
 * keeping closes the ones this viewer may close.
 *
 * A report in the admin queue (routed to the team, or open 14 days) is shown
 * but can't be kept here: it closes when the team does.
 *
 * Setups reporters suggested sit under their report, grouped ("2 climbers
 * suggested …"), each with **Use this setup** for a viewer who may edit the
 * board: one `updateBoard` with that layout, size, sets and (on a board that
 * doesn't tilt) angle, which closes the board's "Set up wrong" reports as
 * fixed. A save that would copy another board of the same owner asks first,
 * as the edit form does, and Save anyway sends `allowDuplicateConfig`. The
 * grouping, the "board has this setup now" check and the input are
 * `@boardsesh/directory-moderation`'s, shared with the app. While a Use this
 * setup button shows, "Fix the setup" reads "Edit it yourself". While one
 * saves, every other answer (fix, remove, delete, keep) is disabled and its
 * handler refuses: the review ends one way only, never kept and changed.
 */
export default function BoardReportReviewDialog({
  board,
  gymName,
  onClose,
  onFix,
  onRemove,
  onDelete,
  allowDelete,
  onResolved,
}: BoardReportReviewDialogProps) {
  const { t, i18n } = useTranslation('boards');
  const { token } = useWsAuthToken();
  const { showMessage } = useSnackbar();
  const [reports, setReports] = useState<DirectoryReport[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [step, setStep] = useState<'review' | 'keep'>('review');
  const [note, setNote] = useState('');
  const [keeping, setKeeping] = useState(false);
  // Use this setup: the setup being saved, and the one a duplicate prompt waits on.
  const [applyingKey, setApplyingKey] = useState<string | null>(null);
  const applyingRef = useRef(false);
  const applyingSetup = applyingKey !== null;
  const [duplicate, setDuplicate] = useState<DuplicateBoardConfig | null>(null);
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  const pendingSetupRef = useRef<BoardSetup | null>(null);
  const requestRef = useRef(0);
  const boardUuid = board?.uuid ?? null;

  // The token is read through a ref: a same-account refresh mustn't reload the
  // list or wipe a note half typed. The dialog is keyed per board by the tab, so
  // a new board starts from fresh state.
  const tokenRef = useRef(token);
  useEffect(() => {
    tokenRef.current = token;
  }, [token]);
  const hasToken = Boolean(token);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    const currentToken = tokenRef.current;
    if (!boardUuid || !currentToken) return;
    setLoadFailed(false);
    setReports(null);
    try {
      const response = await createGraphQLHttpClient(currentToken).request<
        GetBoardReportsQueryResponse,
        GetBoardReportsQueryVariables
      >(GET_BOARD_REPORTS, { boardUuid });
      if (request === requestRef.current) setReports(response.boardReports);
    } catch (error) {
      console.error('Failed to load board reports:', error);
      if (request === requestRef.current) setLoadFailed(true);
    }
  }, [boardUuid]);

  useEffect(() => {
    if (!hasToken) return;
    void load();
    return () => {
      requestRef.current += 1;
    };
  }, [load, hasToken]);

  const rows = reports ? reviewRows(reports) : [];
  const keepable = reports ? reportsToKeep(reports) : [];

  // Every other answer waits for a Use this setup save. The ref, not the state,
  // so a click that lands before the buttons re-render disabled is refused too.
  const openKeepStep = () => {
    if (applyingRef.current) return;
    setStep('keep');
  };
  const handBoardTo = (action: (reportedBoard: UserBoard) => void) => {
    if (!board || applyingRef.current) return;
    action(board);
  };

  const keep = async () => {
    if (!token || keepable.length === 0 || keeping || applyingRef.current) return;
    setKeeping(true);
    const client = createGraphQLHttpClient(token);
    const resolutionNote = normalizeReportNote(note);
    let closed = 0;
    try {
      for (const reportUuid of keepable) {
        try {
          await client.request<ResolveDirectoryReportMutationResponse, ResolveDirectoryReportMutationVariables>(
            RESOLVE_DIRECTORY_REPORT,
            { input: { reportUuid, outcome: 'kept', note: resolutionNote } },
          );
        } catch (error) {
          // Someone else closed it meanwhile: that report is done either way.
          if (!isDirectoryReportClosedError(error)) throw error;
        }
        closed += 1;
      }
      showMessage(t('reportReview.keptToast'), 'success');
      onClose();
    } catch (error) {
      console.error('Failed to close board reports:', error);
      showMessage(
        closed > 0
          ? t('reportReview.web.keepPartial', { closed, total: keepable.length })
          : t('reportReview.keepFailed'),
        'error',
      );
    } finally {
      // Some reports may have closed before a failure: refresh the chip and count either way.
      onResolved();
      setKeeping(false);
    }
  };

  const applySetup = async (setup: BoardSetup, allowDuplicateConfig = false) => {
    if (!board || !token || applyingRef.current) return;
    applyingRef.current = true;
    setApplyingKey(setupKey(setup));
    try {
      await createGraphQLHttpClient(token).request<UpdateBoardMutationResponse, UpdateBoardMutationVariables>(
        UPDATE_BOARD,
        { input: suggestedSetupUpdateInput(board.uuid, setup, { allowDuplicateConfig }) },
      );
      showMessage(t('reportReview.fixedToast'), 'success');
      onResolved();
      onClose();
    } catch (error) {
      // The same wall can exist twice (home and gym): a question, as in the edit form.
      if (isDuplicateBoardError(error)) {
        const duplicateError = readDuplicateBoardError(error);
        pendingSetupRef.current = setup;
        setDuplicate({
          name: duplicateError?.boardName || null,
          locationName: duplicateError?.locationName || null,
        });
        setDuplicateOpen(true);
        track(SHARED_EVENTS.BoardDuplicatePrompted, {
          boardType: board.boardType,
          source: 'web_report_review',
          hasLocation: Boolean(board.locationName),
        });
        return;
      }
      console.error('Failed to use the suggested setup:', error);
      showMessage(t('reportReview.web.useSetupFailed'), 'error');
    } finally {
      applyingRef.current = false;
      setApplyingKey(null);
    }
  };

  const saveAnyway = () => {
    const setup = pendingSetupRef.current;
    setDuplicateOpen(false);
    if (setup) void applySetup(setup, true);
  };

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString(i18n.language, { day: 'numeric', month: 'long' });

  let content: React.ReactNode;
  if (loadFailed) {
    content = (
      <Alert
        severity="error"
        action={
          <Button color="inherit" size="small" onClick={() => void load()} sx={{ textTransform: 'none' }}>
            {t('report.retry')}
          </Button>
        }
      >
        {t('reportReview.loadError')}
      </Alert>
    );
  } else if (reports === null) {
    content = (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
        <CircularProgress aria-label={t('report.loading')} />
      </Box>
    );
  } else if (step === 'keep') {
    content = (
      <TextField
        label={t('reportReview.keepReplyLabel')}
        placeholder={t('reportReview.keepReplyPlaceholder')}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        fullWidth
        multiline
        minRows={3}
        maxRows={6}
        autoFocus
        slotProps={{ htmlInput: { maxLength: REPORT_NOTE_MAX_LENGTH } }}
        sx={{ mt: 1 }}
      />
    );
  } else if (rows.length === 0) {
    content = (
      <Typography variant="body2" color="text.secondary">
        {t('reportReview.empty')}
      </Typography>
    );
  } else {
    content = (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {rows.map((row) => (
          <Box key={row.uuid}>
            <Typography sx={{ fontWeight: themeTokens.typography.fontWeight.semibold }}>
              {t('reportReview.reasonCount', {
                reason: reportReasonLabel(row.reason, 'board', t),
                count: row.reporterCount,
              })}
            </Typography>
            {row.duplicateOfBoardName && (
              <Typography variant="body2" color="text.secondary">
                {t('reportReview.duplicateOf', { board: row.duplicateOfBoardName })}
              </Typography>
            )}
            {row.notes.length > 0 && (
              <Box sx={{ mt: 1 }}>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                  {t('reportReview.notesHeading')}
                </Typography>
                <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
                  {row.notes.map((reporterNote) => (
                    <Typography component="li" variant="body2" key={reporterNote.key} sx={{ overflowWrap: 'anywhere' }}>
                      {reporterNote.text}
                    </Typography>
                  ))}
                </Box>
              </Box>
            )}
            {row.suggestions.length > 0 && board && (
              <Box component="ul" sx={{ m: 0, mt: 1, p: 0, listStyle: 'none', display: 'grid', gap: 1 }}>
                {row.suggestions.map((group) => {
                  const isCurrent = setupMatches(group.setup, board);
                  return (
                    <Box
                      component="li"
                      key={group.key}
                      sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 1.5, rowGap: 0.5 }}
                    >
                      <Typography variant="body2" sx={{ flex: '1 1 16rem', overflowWrap: 'anywhere' }}>
                        {t('reportReview.web.suggested', {
                          count: group.count,
                          setup: boardSetupSummary(board.boardType, group.setup),
                        })}
                      </Typography>
                      {isCurrent ? (
                        <Typography variant="caption" color="text.secondary">
                          {t('reportReview.web.suggestedIsCurrent')}
                        </Typography>
                      ) : (
                        board.canEdit && (
                          <Button
                            variant="outlined"
                            size="small"
                            onClick={() => void applySetup(group.setup)}
                            loading={applyingKey === group.key}
                            disabled={applyingSetup || keeping}
                            sx={{ textTransform: 'none', minHeight: 44 }}
                          >
                            {t('reportReview.web.useSetup')}
                          </Button>
                        )
                      )}
                    </Box>
                  );
                })}
              </Box>
            )}
            {row.footnote && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                {row.footnote === 'team_queue'
                  ? t('reportReview.inTeamQueue')
                  : t('reportReview.teamDate', { date: formatDate(row.escalatesAt) })}
              </Typography>
            )}
          </Box>
        ))}

        <Divider />

        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 1 }}>
          {board?.canEdit && (
            <ReviewAction
              icon={<EditOutlined />}
              label={offersUseThisSetup(rows, board) ? t('reportReview.web.editYourself') : t('reportReview.fix')}
              hint={t('reportReview.fixHint')}
              onClick={() => handBoardTo(onFix)}
              disabled={applyingSetup}
            />
          )}
          {board?.canRemoveFromGym === true && (
            <ReviewAction
              icon={<LinkOffOutlined />}
              label={t('gymBoards.removeFromNamed', { gym: gymName })}
              hint={t('reportReview.removeHint')}
              onClick={() => handBoardTo(onRemove)}
              disabled={applyingSetup}
            />
          )}
          {allowDelete && board?.canDelete === true && (
            <ReviewAction
              icon={<DeleteOutlined />}
              label={t('reportReview.delete')}
              hint={t('reportReview.deleteHint')}
              color="error"
              onClick={() => handBoardTo(onDelete)}
              disabled={applyingSetup}
            />
          )}
          {keepable.length > 0 && (
            <ReviewAction
              icon={<CheckOutlined />}
              label={t('reportReview.keep')}
              hint={t('reportReview.keepHint')}
              onClick={openKeepStep}
              disabled={applyingSetup}
            />
          )}
        </Box>
      </Box>
    );
  }

  return (
    <Dialog open={board !== null} onClose={onClose} maxWidth="sm" fullWidth aria-labelledby="board-report-review-title">
      <DialogTitle id="board-report-review-title">
        {step === 'keep' ? t('reportReview.keep') : t('reportReview.title')}
        {board && (
          <Typography component="span" variant="body2" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
            {board.name}
          </Typography>
        )}
      </DialogTitle>
      <DialogContent>{content}</DialogContent>
      <DialogActions>
        {step === 'keep' ? (
          <>
            <Button onClick={() => setStep('review')} disabled={keeping} sx={{ textTransform: 'none' }}>
              {t('reportReview.back')}
            </Button>
            <Button
              variant="contained"
              onClick={() => void keep()}
              loading={keeping}
              disabled={keepable.length === 0 || applyingSetup}
              sx={{ textTransform: 'none' }}
            >
              {t('report.send')}
            </Button>
          </>
        ) : (
          <Button onClick={onClose} sx={{ textTransform: 'none' }}>
            {t('reportReview.close')}
          </Button>
        )}
      </DialogActions>
      <DuplicateBoardConfigDialog
        open={duplicateOpen}
        duplicate={duplicate}
        saving={applyingKey !== null}
        onClose={() => setDuplicateOpen(false)}
        onSaveAnyway={saveAnyway}
        onExited={() => setDuplicate(null)}
      />
    </Dialog>
  );
}

function ReviewAction({
  icon,
  label,
  hint,
  color = 'primary',
  onClick,
  disabled = false,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  color?: 'primary' | 'error';
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Button
      color={color}
      startIcon={icon}
      onClick={onClick}
      disabled={disabled}
      sx={{ textTransform: 'none', justifyContent: 'flex-start', textAlign: 'left', minHeight: 44 }}
    >
      <Box component="span" sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
        <Box component="span">{label}</Box>
        <Typography component="span" variant="caption" color="text.secondary">
          {hint}
        </Typography>
      </Box>
    </Button>
  );
}
