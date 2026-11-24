'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useQuery } from '@tanstack/react-query';
import { useOptionalBrowserSession } from '@/app/components/providers/session-provider';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormLabel from '@mui/material/FormLabel';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import MuiLink from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import CheckCircleOutlined from '@mui/icons-material/CheckCircleOutline';
import { REPORT_NOTE_MAX_LENGTH } from '@boardsesh/directory-moderation';
import { boardSetupSummary } from '@boardsesh/board-config';
import type { SimilarGym } from '@boardsesh/shared-schema';
import {
  FIND_SIMILAR_GYMS,
  REPORT_BOARD,
  REPORT_GYM,
  type FindSimilarGymsQueryResponse,
  type FindSimilarGymsQueryVariables,
  type ReportBoardMutationResponse,
  type ReportBoardMutationVariables,
  type ReportGymMutationResponse,
  type ReportGymMutationVariables,
} from '@boardsesh/graphql/operations';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { useDebouncedValue } from '@/app/hooks/use-debounced-value';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import LocaleLink from '@/app/components/i18n/locale-link';
import { buildClaimReturnPath } from '@/app/gym/[gym_slug]/gym-claim-cta-logic';
import { themeTokens } from '@/app/theme/theme-config';
import StoreInstallButtons, { type StoreButtonLabels } from '@/app/components/marketing/store-install-buttons';
import { MobileInstallBlock } from '@/app/components/climb-front-door/front-door-cta-parts';
import {
  EMPTY_REPORT_DRAFT,
  NOT_SURE_DUPLICATE,
  buildReportBoardInput,
  buildReportGymInput,
  canSendReport,
  chooseReason,
  claimNudgeGym,
  draftSetupSelection,
  noteIsRequired,
  reportAudienceFor,
  reportErrorKind,
  reportReasonsFor,
  setupFieldsBoard,
  setupPreviewFor,
  shouldResetReportDialog,
  sentMessageFor,
  sentMessageForError,
  type ReportBoardSetup,
  type ReportDraft,
  type ReportProblemTarget,
  type ReportReason,
  type ReportSentMessage,
} from './report-problem-logic';
import {
  reportAudienceLine,
  reportReasonHint,
  reportReasonLabel,
  setupPreviewLine,
  setupReviewLine,
} from './report-copy';
import SetupSuggestionFields from './setup-suggestion-fields';

type ReportProblemDialogProps = {
  open: boolean;
  onClose: () => void;
  /** Null while the page is still reading what the dialog needs (the board list page reads it on open). */
  target: ReportProblemTarget | null;
  /** The read behind a null target failed. */
  loadFailed?: boolean;
  onRetryLoad?: () => void;
  /**
   * The `directory-setup-suggestions` flag, read by the page: "Set up wrong"
   * shows the setup fields. Off, the dialog offers the note only.
   */
  setupSuggestionsEnabled?: boolean;
  /**
   * The store badges' words, translated by the page (`getStoreButtonLabels`),
   * for the app link after a suggestion changed the board. Without them the
   * done state says so in words only.
   */
  storeLabels?: StoreButtonLabels | null;
  /**
   * A suggestion changed the board for everyone, or the server found the board
   * already has it: the page reads it again, so its rows and a reopened dialog
   * show the setup it has now.
   */
  onSetupApplied?: () => void;
};

/** What the done state shows: the message, and the setup a suggestion changed the board to. */
type SentState = { message: ReportSentMessage; setupSummary: string | null };

const MIN_GYM_SEARCH_LENGTH = 2;

/**
 * Report a problem with a board or a gym listing: one dialog for both, opened
 * from the gym page's board rows and its "Report a problem" button, the board
 * list page's link and the manage page's lock state
 * (docs/product/directory-reports.md).
 *
 * The reason list, then what that reason needs in the same dialog (the other
 * board or listing for "Listed twice", a note, required for "Something
 * else"), then a line saying who will read it, worded from the routing the
 * server uses. Sent, it says what happened: a new report, joining others who
 * flagged the same thing, or one the climber already sent.
 *
 * With the `directory-setup-suggestions` flag on, "Set up wrong" on a board
 * that isn't a spray wall shows the setup fields (Layout, Size, Holds, and
 * Angle on a board that doesn't tilt), starting on the board's current setup,
 * and Send waits for a setup that differs. The foot line then says what Send
 * does: change it for everyone at a gym nobody runs, or wait for the gym's
 * staff or the board's creator; no line when the gym's state didn't load. Sent,
 * a change that applied says so and points to the app to climb it; one that
 * went to review says why. A board someone fixed since the page read it
 * already has the setup, and the dialog says so.
 */
export default function ReportProblemDialog({
  open,
  onClose,
  target,
  loadFailed = false,
  onRetryLoad,
  setupSuggestionsEnabled = false,
  storeLabels = null,
  onSetupApplied,
}: ReportProblemDialogProps) {
  const { t } = useTranslation('boards');
  const { token } = useWsAuthToken();
  const session = useOptionalBrowserSession()?.data;
  const viewerUserId = session?.user?.id ?? null;
  const [draft, setDraft] = useState<ReportDraft>(EMPTY_REPORT_DRAFT);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<SentState | null>(null);
  const [failure, setFailure] = useState<'offline' | 'error' | null>(null);

  const targetKey = target ? (target.kind === 'board' ? `board:${target.board.uuid}` : `gym:${target.gym.uuid}`) : null;
  const setupBoard = target ? setupFieldsBoard(target, draft.reason, setupSuggestionsEnabled) : null;

  // One dialog serves every row on the gym page: start clean for each target.
  // The target reads null while a token rotation or a reload is in flight, so a
  // change to or from null is not a new target: it must not wipe a draft or the
  // sent message.
  const requestGenerationRef = useRef(0);
  const previousResetRef = useRef<{ open: boolean; targetKey: string | null }>({ open: false, targetKey: null });
  useEffect(() => {
    const previous = previousResetRef.current;
    // Remember the last real target across a null gap, so A → null → B still resets.
    previousResetRef.current = { open, targetKey: targetKey ?? previous.targetKey };
    if (!open) return;
    if (shouldResetReportDialog(previous, { open, targetKey })) {
      requestGenerationRef.current += 1;
      setDraft(EMPTY_REPORT_DRAFT);
      setSending(false);
      setSent(null);
      setFailure(null);
    }
  }, [open, targetKey]);

  const send = async () => {
    if (!target || sending) return;
    requestGenerationRef.current += 1;
    const generation = requestGenerationRef.current;
    const isCurrent = () => requestGenerationRef.current === generation;
    setSending(true);
    setFailure(null);
    try {
      const client = createGraphQLHttpClient(token);
      if (target.kind === 'board') {
        const input = buildReportBoardInput(target.board.uuid, draft, setupBoard);
        if (!input) return;
        const setupSummary =
          setupBoard && input.suggestedSetup ? boardSetupSummary(setupBoard.boardType, input.suggestedSetup) : null;
        let message: ReportSentMessage;
        try {
          const response = await client.request<ReportBoardMutationResponse, ReportBoardMutationVariables>(
            REPORT_BOARD,
            { input },
          );
          message = sentMessageFor(response.reportBoard);
        } catch (error) {
          // The board already has the suggested setup: done, not a failure.
          const settled = sentMessageForError(error);
          if (!settled) throw error;
          message = settled;
        }
        if (isCurrent()) {
          setSent({ message, setupSummary });
          if (message.kind === 'setup_applied' || message.kind === 'setup_unchanged') onSetupApplied?.();
        }
      } else {
        const input = buildReportGymInput(target.gym.uuid, draft);
        if (!input) return;
        const response = await client.request<ReportGymMutationResponse, ReportGymMutationVariables>(REPORT_GYM, {
          input,
        });
        if (isCurrent()) setSent({ message: sentMessageFor(response.reportGym), setupSummary: null });
      }
    } catch (error) {
      console.error('Report a problem failed:', error);
      if (!isCurrent()) return;
      setFailure(reportErrorKind(typeof navigator === 'undefined' ? true : navigator.onLine));
    } finally {
      if (isCurrent()) setSending(false);
    }
  };

  const subtitle = target
    ? target.kind === 'board'
      ? target.gym
        ? t('report.boardAtGym', { board: target.board.name, gym: target.gym.name })
        : target.board.name
      : target.gym.name
    : null;

  let body: React.ReactNode;
  if (!target) {
    body = loadFailed ? (
      <Alert
        severity="error"
        action={
          onRetryLoad ? (
            <Button color="inherit" size="small" onClick={onRetryLoad} sx={{ textTransform: 'none' }}>
              {t('report.retry')}
            </Button>
          ) : undefined
        }
      >
        {t('report.loadError')}
      </Alert>
    ) : (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
        <CircularProgress aria-label={t('report.loading')} />
      </Box>
    );
  } else if (sent) {
    const gymName = target.gym?.name ?? null;
    // The board now has the suggested setup, whether this send changed it or it already had it.
    const boardIsOnSetup = sent.message.kind === 'setup_applied' || sent.message.kind === 'setup_unchanged';
    body = (
      <>
        <Box
          role="status"
          sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.5, py: 2, textAlign: 'center' }}
        >
          <CheckCircleOutlined color="success" sx={{ fontSize: 40 }} />
          <Typography variant="body1">{sentLine(sent.message, gymName, t)}</Typography>
          {boardIsOnSetup && sent.setupSummary && (
            <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
              {sent.setupSummary}
            </Typography>
          )}
        </Box>
        {boardIsOnSetup && <ClimbItInTheApp labels={storeLabels} />}
      </>
    );
  } else {
    body = (
      <ReportForm
        target={target}
        draft={draft}
        onDraftChange={setDraft}
        viewerUserId={viewerUserId}
        failure={failure}
        open={open}
        onClaimNudge={onClose}
        setupBoard={setupBoard}
      />
    );
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth aria-labelledby="report-problem-title">
      <DialogTitle id="report-problem-title">
        {t('report.title')}
        {subtitle && (
          <Typography component="span" variant="body2" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
            {subtitle}
          </Typography>
        )}
      </DialogTitle>
      <DialogContent>{body}</DialogContent>
      <DialogActions>
        <Button onClick={onClose} sx={{ textTransform: 'none' }}>
          {sent ? t('report.done') : t('report.cancel')}
        </Button>
        {target && !sent && (
          <Button
            variant="contained"
            onClick={() => void send()}
            disabled={!canSendReport(draft, setupBoard) || sending || !token}
            loading={sending}
            sx={{ textTransform: 'none' }}
          >
            {t('report.send')}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

/** The done state's sentence. */
function sentLine(message: ReportSentMessage, gym: string | null, t: TFunction<'boards'>): string {
  switch (message.kind) {
    case 'already':
      return t('report.alreadyReported');
    case 'joined':
      return t('report.joined', { count: message.count });
    case 'setup_applied':
      return gym ? t('report.web.setup.applied', { gym }) : t('report.web.setup.appliedUnnamed');
    case 'setup_review':
      return setupReviewLine(message.reason, gym, t);
    case 'setup_unchanged':
      return t('report.web.setup.alreadySetUp');
    case 'sent':
      return t('report.sent');
  }
}

/**
 * After a suggestion changed the board: climb it in the app. On a phone the
 * one badge for its store comes first, as on the public pages
 * (docs/web/public-page-design.md, "Calls to action"); from md, where the
 * laptop can't light a board, both badges. The pair keeps the black, paired
 * badges (`sharedHtml`): the page behind the dialog can show other store
 * badges, and Apple allows its white badge only when it is the one on the page.
 */
function ClimbItInTheApp({ labels }: { labels: StoreButtonLabels | null }) {
  const { t } = useTranslation('boards');
  const helper = t('report.web.setup.climbInApp');
  if (!labels) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center' }}>
        {helper}
      </Typography>
    );
  }
  return (
    <Box data-cta="setup-report-install" sx={{ display: 'grid', justifyItems: 'center' }}>
      <MobileInstallBlock placement="setup-report" labels={labels} helper={helper} />
      <Box sx={{ display: { xs: 'none', md: 'grid' }, justifyItems: 'center', gap: 1.5 }}>
        <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center' }}>
          {helper}
        </Typography>
        <StoreInstallButtons placement="setup-report" labels={labels} sharedHtml />
      </Box>
    </Box>
  );
}

function ReportForm({
  target,
  draft,
  onDraftChange,
  viewerUserId,
  failure,
  open,
  onClaimNudge,
  setupBoard,
}: {
  target: ReportProblemTarget;
  draft: ReportDraft;
  onDraftChange: (draft: ReportDraft) => void;
  viewerUserId: string | null;
  failure: 'offline' | 'error' | null;
  open: boolean;
  onClaimNudge: () => void;
  /** The board whose setup the fields edit, or null when they don't show (`setupFieldsBoard`). */
  setupBoard: ReportBoardSetup | null;
}) {
  const { t } = useTranslation('boards');
  const reasons = reportReasonsFor(target.kind);
  const audience = reportAudienceFor(target, draft.reason, viewerUserId);
  const claimGym = claimNudgeGym(target);
  const required = noteIsRequired(draft.reason);
  const creatorName = target.kind === 'board' ? target.board.ownerDisplayName : null;
  const setupSelection = setupBoard ? draftSetupSelection(draft, setupBoard) : null;
  const setupPreview = setupSelection ? setupPreviewFor(target) : null;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <FormControl component="fieldset">
        <FormLabel component="legend" sx={{ mb: 1, color: 'text.primary' }}>
          {t('report.question')}
        </FormLabel>
        <RadioGroup
          name="report-reason"
          value={draft.reason ?? ''}
          onChange={(event) => onDraftChange(chooseReason(draft, event.target.value as ReportReason))}
        >
          {reasons.map((reason) => {
            const hint = reportReasonHint(reason, target.kind, t);
            return (
              <FormControlLabel
                key={reason}
                value={reason}
                control={<Radio />}
                sx={{ alignItems: 'flex-start', mb: 0.5, '& .MuiRadio-root': { mt: -0.5 } }}
                label={
                  <Box sx={{ pt: 0.5 }}>
                    <Typography component="span" sx={{ display: 'block' }}>
                      {reportReasonLabel(reason, target.kind, t)}
                    </Typography>
                    {hint && (
                      <Typography component="span" variant="body2" color="text.secondary" sx={{ display: 'block' }}>
                        {hint}
                      </Typography>
                    )}
                  </Box>
                }
              />
            );
          })}
        </RadioGroup>
      </FormControl>

      {draft.reason === 'duplicate' && target.kind === 'board' && target.otherBoards.length > 0 && (
        <FormControl component="fieldset">
          <FormLabel component="legend" sx={{ mb: 1, color: 'text.primary' }}>
            {t('report.duplicateBoardPick')}
          </FormLabel>
          <RadioGroup
            name="report-duplicate-board"
            value={draft.duplicateBoardPick ?? ''}
            onChange={(event) => onDraftChange({ ...draft, duplicateBoardPick: event.target.value })}
          >
            {target.otherBoards.map((option) => (
              <FormControlLabel key={option.uuid} value={option.uuid} control={<Radio />} label={option.label} />
            ))}
            <FormControlLabel value={NOT_SURE_DUPLICATE} control={<Radio />} label={t('report.notSure')} />
          </RadioGroup>
        </FormControl>
      )}

      {draft.reason === 'duplicate' && target.kind === 'gym' && (
        <GymDuplicatePicker
          gym={target.gym}
          selectedUuid={draft.duplicateGymUuid}
          onSelect={(uuid) => onDraftChange({ ...draft, duplicateGymUuid: uuid })}
          enabled={open}
        />
      )}

      {setupSelection && (
        <SetupSuggestionFields
          selection={setupSelection}
          onChange={(selection) => onDraftChange({ ...draft, setup: selection })}
        />
      )}

      {draft.reason && (
        <TextField
          label={required ? t('report.web.noteRequiredLabel') : t('report.noteLabel')}
          placeholder={draft.reason === 'wrong_setup' && !setupSelection ? t('report.notePlaceholder') : undefined}
          value={draft.note}
          onChange={(event) => onDraftChange({ ...draft, note: event.target.value })}
          required={required}
          fullWidth
          size="small"
          multiline
          minRows={2}
          maxRows={6}
          slotProps={{ htmlInput: { maxLength: REPORT_NOTE_MAX_LENGTH } }}
        />
      )}

      {failure && <Alert severity="error">{failure === 'offline' ? t('report.offline') : t('report.error')}</Alert>}

      {/* With the setup fields showing, a gym whose state didn't load gets no line: no guess at who decides. */}
      {(!setupSelection || setupPreview) && (
        <Typography variant="body2" color="text.secondary">
          {setupPreview
            ? setupPreviewLine(setupPreview, target.gym?.name ?? null, t)
            : reportAudienceLine(audience, { creator: creatorName, gym: target.gym?.name ?? null }, t)}
        </Typography>
      )}

      {claimGym?.slug && (
        <MuiLink
          component={LocaleLink}
          href={buildClaimReturnPath(claimGym.slug)}
          onClick={onClaimNudge}
          sx={{ display: 'inline-flex', alignItems: 'center', minHeight: 44, alignSelf: 'flex-start' }}
        >
          {t('report.claimNudge', { gym: claimGym.name })}
        </MuiLink>
      )}
    </Box>
  );
}

/**
 * "Find the other listing": gyms like this one, from the same search the old
 * duplicate report used. Picking one is optional; the team looks either way.
 */
function GymDuplicatePicker({
  gym,
  selectedUuid,
  onSelect,
  enabled,
}: {
  gym: { uuid: string; name: string; latitude?: number | null; longitude?: number | null };
  selectedUuid: string | null;
  onSelect: (uuid: string | null) => void;
  enabled: boolean;
}) {
  const { t } = useTranslation('boards');
  const { token } = useWsAuthToken();
  const [search, setSearch] = useState(gym.name);
  const debounced = useDebouncedValue(
    useMemo(
      () => ({ name: search.trim(), latitude: gym.latitude ?? null, longitude: gym.longitude ?? null }),
      [search, gym.latitude, gym.longitude],
    ),
    400,
  );
  const queryEnabled = enabled && Boolean(token) && debounced.name.length >= MIN_GYM_SEARCH_LENGTH;
  const { data, isFetching } = useQuery<SimilarGym[]>({
    queryKey: ['reportProblemSimilarGyms', debounced.name, debounced.latitude, debounced.longitude],
    enabled: queryEnabled,
    staleTime: 30_000,
    retry: false,
    queryFn: async () => {
      const client = createGraphQLHttpClient(token);
      const response = await client.request<FindSimilarGymsQueryResponse, FindSimilarGymsQueryVariables>(
        FIND_SIMILAR_GYMS,
        {
          input: {
            name: debounced.name,
            latitude: debounced.latitude ?? undefined,
            longitude: debounced.longitude ?? undefined,
          },
        },
      );
      return response.findSimilarGyms;
    },
  });
  // Never offer the gym as its own duplicate.
  const candidates = (data ?? []).filter((candidate) => candidate.uuid !== gym.uuid);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <TextField
        label={t('report.duplicateGymSearch')}
        value={search}
        onChange={(event) => {
          setSearch(event.target.value);
          onSelect(null);
        }}
        fullWidth
        size="small"
        placeholder={t('report.gymSearchPlaceholder')}
      />
      {isFetching && candidates.length === 0 ? (
        <Box sx={{ textAlign: 'center', py: 1 }}>
          <CircularProgress size={20} aria-label={t('report.loading')} />
        </Box>
      ) : candidates.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          {t('report.noMatches')}
        </Typography>
      ) : (
        <Stack spacing={1}>
          {candidates.map((candidate) => {
            const isSelected = selectedUuid === candidate.uuid;
            return (
              <Card
                key={candidate.uuid}
                variant="outlined"
                sx={{
                  borderRadius: `${themeTokens.borderRadius.md}px`,
                  borderColor: isSelected ? themeTokens.colors.primary : undefined,
                  borderWidth: isSelected ? 2 : 1,
                }}
              >
                <CardActionArea
                  onClick={() => onSelect(isSelected ? null : candidate.uuid)}
                  aria-pressed={isSelected}
                  sx={{ p: 1.5, minHeight: 44 }}
                >
                  <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
                    <Typography
                      variant="subtitle2"
                      sx={{ fontWeight: themeTokens.typography.fontWeight.semibold, overflowWrap: 'anywhere' }}
                    >
                      {candidate.name}
                    </Typography>
                    {isSelected && <CheckCircleOutlined color="primary" sx={{ fontSize: 20, flexShrink: 0 }} />}
                  </Box>
                  {candidate.address && (
                    <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                      {candidate.address}
                    </Typography>
                  )}
                </CardActionArea>
              </Card>
            );
          })}
        </Stack>
      )}
    </Box>
  );
}
