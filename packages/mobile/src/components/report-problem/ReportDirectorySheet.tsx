// "Report a problem" for a board or a gym listing (design §3a). The climber
// picks what's wrong; for "Listed twice" on a board they can name the other
// board at the same gym; a note is optional except for "Something else". The
// foot says who will see it, worded from the same routing the server uses,
// and on a gym nobody runs yet offers the claim instead.

import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import {
  OTHER_REASON_NOTE_MIN_LENGTH,
  REPORT_NOTE_MAX_LENGTH,
  normalizeReportNote,
  type BoardReportReason,
  type GymReportReason,
  type ReportAudience,
} from '@boardsesh/directory-moderation';
import type { DirectoryReportSubmitResult, Gym, UserBoard } from '@boardsesh/shared-schema';
import type { RadioOption } from '../RadioGroup';
import { RadioGroup } from '../RadioGroup';
import { Text } from '../Text';
import { TextAction } from '../TextAction';
import { TickNoteField } from '../tick';
import { ReportProblemSheet } from './ReportProblemSheet';
import {
  BOARD_REASONS,
  DUPLICATE_NOT_SURE,
  GYM_REASONS,
  boardReportAudience,
  canSendReport,
  gymReportAudience,
  reportDoneCopy,
  showClaimNudge,
} from './report-problem-model';
import { useGym, useGymBoards } from '../../lib/graphql/hooks';
import { useReportBoard, useReportGym } from '../../lib/graphql/hooks/use-directory-reports';
import { useConnectivity } from '../../lib/connectivity/use-connectivity';
import { useViewerUserId } from '../../hooks/use-viewer-user-id';
import { track } from '../../lib/analytics';
import { dismissManagedSheetAndWait, type ManagedSheetHandle } from '../../providers/sheet-presentation-provider';
import { spacing } from '../../theme/tokens';

/** What a report is about. A gym page passes the gym; every board surface the board. */
export type ReportProblemTarget = { kind: 'board'; board: UserBoard } | { kind: 'gym'; gym: Gym };

type TFn = ReturnType<typeof useTranslation>['t'];

function boardReasonLabel(reason: BoardReportReason, t: TFn): { label: string; description?: string } {
  switch (reason) {
    case 'wrong_setup':
      return { label: t('report.boardReasons.wrongSetup'), description: t('report.boardReasons.wrongSetupHint') };
    case 'duplicate':
      return { label: t('report.boardReasons.duplicate'), description: t('report.boardReasons.duplicateHint') };
    case 'gone':
      return { label: t('report.boardReasons.gone'), description: t('report.boardReasons.goneHint') };
    case 'wrong_place':
      return { label: t('report.boardReasons.wrongPlace'), description: t('report.boardReasons.wrongPlaceHint') };
    case 'other':
    case 'relist_request':
      return { label: t('report.boardReasons.other') };
  }
}

function gymReasonLabel(reason: GymReportReason, t: TFn): { label: string; description?: string } {
  switch (reason) {
    case 'duplicate':
      return { label: t('report.gymReasons.duplicate'), description: t('report.gymReasons.duplicateHint') };
    case 'closed':
      return { label: t('report.gymReasons.closed'), description: t('report.gymReasons.closedHint') };
    case 'wrong_details':
      return { label: t('report.gymReasons.details'), description: t('report.gymReasons.detailsHint') };
    case 'not_a_gym':
      return { label: t('report.gymReasons.home'), description: t('report.gymReasons.homeHint') };
    case 'other':
      return { label: t('report.gymReasons.other') };
  }
}

/**
 * The "who will see this" line. A switch with literal keys, not
 * `REPORT_AUDIENCE_COPY_KEYS[audience]`: the linter refuses `t(variable)`.
 */
export function reportAudienceLine(audience: ReportAudience, params: { name: string; gym: string }, t: TFn): string {
  switch (audience) {
    case 'creator':
      return t('report.routeCreator', params);
    case 'creator_hidden':
      return t('report.routeCreatorHidden', params);
    case 'creator_and_staff':
      return t('report.routeCreatorAndStaff', params);
    case 'creator_hidden_and_staff':
      return t('report.routeCreatorHiddenAndStaff', params);
    case 'creator_and_team':
      return t('report.routeCreatorAndTeam', params);
    case 'creator_hidden_and_team':
      return t('report.routeCreatorHiddenAndTeam', params);
    case 'creator_staff_and_team':
      return t('report.routeCreatorStaffAndTeam', params);
    case 'creator_hidden_staff_and_team':
      return t('report.routeCreatorHiddenStaffAndTeam', params);
    case 'staff':
      return t('report.routeStaff', params);
    case 'staff_and_team':
      return t('report.routeGymAndStaff', params);
    case 'team_unclaimed_gym':
      return t('report.routeTeam', params);
    case 'team':
      return t('report.routeGym', params);
  }
}

type ReportReason = BoardReportReason | GymReportReason;

export function ReportDirectorySheet({
  target,
  onClose,
  onClaim,
}: {
  target: ReportProblemTarget;
  onClose: () => void;
  /**
   * "Run {{gym}}? Claim it": called once this sheet has fully dismissed, so the
   * host can present the claim sheet without overlapping the two.
   */
  onClaim: (gym: Gym) => void;
}) {
  const { t } = useTranslation('boards');
  const { effectiveOffline } = useConnectivity();
  const viewerUserId = useViewerUserId();
  const board = target.kind === 'board' ? target.board : null;
  const boardGymUuid = board?.gymUuid ?? null;
  // A board report words its foot from its gym's listing state, which the board
  // doesn't carry. A gym report already has its gym.
  const { data: fetchedGym } = useGym(board ? boardGymUuid : null);
  const gym: Gym | null = target.kind === 'gym' ? target.gym : (fetchedGym ?? null);

  const [reason, setReason] = useState<ReportReason | null>(null);
  const [note, setNote] = useState('');
  const [duplicateOf, setDuplicateOf] = useState<string | null>(null);
  const [result, setResult] = useState<DirectoryReportSubmitResult | null>(null);
  const inFlight = useRef(false);

  // Two native sheets can't overlap a present with a dismiss (the coordinator
  // rule in docs/mobile/mobile-sheets-vs-routes.md): this sheet goes and
  // settles first, then the host presents the claim. Same handoff as the
  // review sheet's board actions.
  const sheetRef = useRef<ManagedSheetHandle>(null);
  const claiming = useRef(false);
  const claim = useCallback(
    async (claimTarget: Gym) => {
      if (claiming.current) return;
      claiming.current = true;
      const dismissal = await dismissManagedSheetAndWait(sheetRef.current);
      // The host went away mid-handoff: nothing left to present the claim from.
      if (dismissal.status === 'aborted') return;
      onClaim(claimTarget);
    },
    [onClaim],
  );

  const reportBoard = useReportBoard();
  const reportGym = useReportGym();
  const mutation = target.kind === 'board' ? reportBoard : reportGym;
  const pending = mutation.isPending;

  // The other boards at this gym, for "Which board is the same wall?". Only
  // asked for once "Listed twice" is picked.
  const { data: gymBoards } = useGymBoards(board && reason === 'duplicate' ? boardGymUuid : null);
  const otherBoards = useMemo(
    () => (board ? (gymBoards ?? []).filter((candidate) => candidate.uuid !== board.uuid) : []),
    [gymBoards, board],
  );

  const reasonOptions = useMemo<RadioOption<ReportReason>[]>(
    () =>
      target.kind === 'board'
        ? BOARD_REASONS.map((value) => ({ value, ...boardReasonLabel(value, t), disabled: pending }))
        : GYM_REASONS.map((value) => ({ value, ...gymReasonLabel(value, t), disabled: pending })),
    [target.kind, t, pending],
  );
  const duplicateOptions = useMemo<RadioOption<string>[]>(
    () => [
      ...otherBoards.map((candidate) => ({ value: candidate.uuid, label: candidate.name })),
      { value: DUPLICATE_NOT_SURE, label: t('report.notSure') },
    ],
    [otherBoards, t],
  );

  const pickReason = useCallback(
    (next: ReportReason) => {
      if (!pending) setReason(next);
    },
    [pending],
  );
  const changeNote = useCallback((next: string) => setNote(next.slice(0, REPORT_NOTE_MAX_LENGTH)), []);
  const pickDuplicate = useCallback(
    (next: string) => {
      if (!pending) setDuplicateOf(next);
    },
    [pending],
  );

  const canSend = canSendReport(reason, note) && !effectiveOffline;
  const send = useCallback(() => {
    if (!reason || !canSendReport(reason, note) || effectiveOffline || inFlight.current || result) return;
    inFlight.current = true;
    const onSuccess = (submitted: DirectoryReportSubmitResult) => {
      setResult(submitted);
      track(SHARED_EVENTS.ReportProblemSent, {
        targetKind: target.kind,
        reason,
        status: submitted.status,
        platform: Platform.OS,
      });
    };
    const onSettled = () => {
      inFlight.current = false;
    };
    const normalizedNote = normalizeReportNote(note);
    if (target.kind === 'board') {
      reportBoard.mutate(
        {
          boardUuid: target.board.uuid,
          reason: reason as BoardReportReason,
          duplicateOfBoardUuid:
            reason === 'duplicate' && duplicateOf && duplicateOf !== DUPLICATE_NOT_SURE ? duplicateOf : null,
          note: normalizedNote,
        },
        { onSuccess, onSettled },
      );
    } else {
      reportGym.mutate(
        { gymUuid: target.gym.uuid, reason: reason as GymReportReason, note: normalizedNote },
        { onSuccess, onSettled },
      );
    }
  }, [reason, note, effectiveOffline, result, target, duplicateOf, reportBoard, reportGym]);

  const gymName = gym?.name ?? board?.gymName ?? '';
  const subject =
    target.kind === 'gym'
      ? target.gym.name
      : board && gymName
        ? t('report.boardAtGym', { board: board.name, gym: gymName })
        : (board?.name ?? null);

  const audience: ReportAudience | null = board
    ? boardReportAudience({
        board,
        reason: (reason as BoardReportReason | null) ?? null,
        viewerUserId,
        gymListingState: gym?.listingState ?? null,
      })
    : gym
      ? gymReportAudience((reason as GymReportReason | null) ?? null, gym.listingState)
      : null;
  const audienceLine = audience
    ? reportAudienceLine(audience, { name: board?.ownerDisplayName ?? '', gym: gymName }, t)
    : null;

  let doneMessage: string | null = null;
  if (result) {
    const done = reportDoneCopy(result);
    doneMessage =
      done.kind === 'already_reported'
        ? t('report.alreadyReported')
        : done.kind === 'joined'
          ? t('report.joined', { count: done.count })
          : t('report.sent');
  }

  const noteRequired = reason === 'other';
  const trimmedLength = note.trim().length;
  const remaining = noteRequired ? Math.max(0, OTHER_REASON_NOTE_MIN_LENGTH - trimmedLength) : 0;
  let detail: ReactNode = null;
  if (reason !== null) {
    detail = (
      <View style={styles.detail}>
        {reason === 'duplicate' && board && otherBoards.length > 0 ? (
          <View style={styles.detail}>
            <Text variant="subheadline" tone="secondary">
              {t('report.duplicateBoardPick')}
            </Text>
            <View
              pointerEvents={pending ? 'none' : 'auto'}
              accessibilityState={{ disabled: pending }}
              style={pending ? styles.locked : undefined}
            >
              <RadioGroup options={duplicateOptions} value={duplicateOf} onChange={pickDuplicate} />
            </View>
          </View>
        ) : null}
        <TickNoteField
          submitBehavior="newline"
          value={note}
          onChangeText={changeNote}
          placeholder={
            noteRequired
              ? t('report.noteRequiredPlaceholder')
              : reason === 'wrong_setup'
                ? t('report.notePlaceholder')
                : t('report.noteLabel')
          }
          accessibilityLabel={noteRequired ? t('report.noteRequiredLabel') : t('report.noteLabel')}
        />
        {remaining > 0 ? (
          <Text variant="footnote" tone="secondary">
            {t('report.noteRemaining', { count: remaining })}
          </Text>
        ) : null}
      </View>
    );
  }

  const footer =
    audienceLine || showClaimNudge(gym) ? (
      <View style={styles.footer}>
        {audienceLine ? (
          <Text variant="footnote" tone="secondary" testID="report-problem-audience">
            {audienceLine}
          </Text>
        ) : null}
        {gym && showClaimNudge(gym) ? (
          <TextAction
            label={t('report.claimNudge', { gym: gym.name })}
            onPress={() => void claim(gym)}
            reach="up"
            testID="report-problem-claim"
          />
        ) : null}
      </View>
    ) : null;

  return (
    <ReportProblemSheet
      title={t('report.title')}
      subject={subject}
      question={t('report.question')}
      reasons={reasonOptions}
      reason={reason}
      onReasonChange={pickReason}
      detail={detail}
      footer={footer}
      sendLabel={t('report.send')}
      canSend={canSend}
      pending={pending}
      onSend={send}
      doneMessage={doneMessage}
      offlineMessage={effectiveOffline ? t('report.offline') : null}
      errorMessage={mutation.isError ? t('report.error') : null}
      dirty={reason !== null || note.length > 0}
      onClose={onClose}
      sheetRef={sheetRef}
      testID="report-problem"
    />
  );
}

const styles = StyleSheet.create({
  detail: { gap: spacing[2] },
  footer: { gap: spacing[2], alignItems: 'flex-start' },
  locked: { opacity: 0.5 },
});
