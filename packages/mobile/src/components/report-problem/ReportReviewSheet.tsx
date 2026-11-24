// The report review sheet (design §3b): what climbers flagged on a board, for
// the climber who added it and the gym's staff, and the four ways to answer.
// Reporters are never named: reasons, a count and their notes.
//
// Fix, Remove and Delete close this sheet and hand the board to the host, which
// owns the board edit route and the confirms the picker already runs for its
// own menu. "It's right as it is" is step 2 of this sheet: an optional note,
// then every report this viewer may close is closed as kept.
//
// Setups climbers suggested on "Set up wrong" (the `directory-setup-suggestions`
// flag) are grouped by setup, each with "Use this setup": the same `updateBoard`
// the edit screen saves with, which closes the waiting reports as fixed. The
// edit route stays one row down as "Edit it yourself". The most suggested few
// show (`MAX_SUGGESTED_SETUPS_SHOWN`), the rest as one count, so the sheet's
// scroll view never maps an unbounded list. While one of them saves, every
// other answer waits: the review ends one way only.

import { useCallback, useMemo, useRef, useState } from 'react';
import { StyleSheet, View, type ColorValue } from 'react-native';
import { useTranslation } from 'react-i18next';
import {
  REPORT_NOTE_MAX_LENGTH,
  SETUP_SUGGESTION_REPORT_REASON,
  groupSuggestedSetups,
  normalizeReportNote,
  setupMatches,
  suggestedSetupUpdateInput,
  type DirectoryReportReason,
  type SuggestedSetupGroup,
} from '@boardsesh/directory-moderation';
import { isDuplicateBoardError, readDuplicateBoardError } from '@boardsesh/graphql/errors';
import type { DirectoryReport, UserBoard } from '@boardsesh/shared-schema';
import { Button } from '../Button';
import { MEDIUM_LARGE_SNAP_POINTS } from '../sheet-snap-points';
import { ModalSheet } from '../ModalSheet';
import { SheetTopBar } from '../SheetTopBar';
import { Text } from '../Text';
import { Icon } from '../Icon';
import type { IconName } from '../icon-map';
import { ActivityIndicator } from '../ActivityIndicator';
import { InsetGroupedList, insetGroupedRowStyles } from '../InsetGroupedList';
import { PressableSurface } from '../PressableSurface';
import { TickNoteField } from '../tick';
import { useUnsavedSheetGuard } from '../../hooks/use-unsaved-sheet-guard';
import {
  useBoardReports,
  useRefreshBoardReportReads,
  useResolveDirectoryReport,
} from '../../lib/graphql/hooks/use-directory-reports';
import { useUpdateBoard } from '../../lib/graphql/hooks';
import { useApplyChangedBoard } from '../../lib/boards/use-apply-changed-board';
import { useConfirm } from '../../providers/dialog-provider';
import { useDirectorySetupSuggestionsEnabled } from '../../providers/feature-flags-provider';
import { getCachedDateTimeFormat } from '../../lib/intl-formatter-cache';
import { useTheme } from '../../providers/theme-provider';
import { useToast } from '../../providers/toast-provider';
import { dismissManagedSheetAndWait, type ManagedSheetHandle } from '../../providers/sheet-presentation-provider';
import { spacing } from '../../theme/tokens';
import {
  MAX_SUGGESTED_SETUPS_SHOWN,
  keepableReports,
  reviewFootnote,
  reviewNotes,
  waitingReports,
} from './report-review-model';
import { formatSetupSummary } from './setup-summary';

/** What the host does for a board action picked in the sheet. */
export type ReportReviewAction = 'fix' | 'remove' | 'delete';

const REVIEW_DATE_OPTIONS: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };

/** "7 Dec" / "Dec 7", in the reader's language; null for a value that is not a date. */
export function formatReviewDate(value: string, locale: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return getCachedDateTimeFormat(locale, REVIEW_DATE_OPTIONS).format(date);
}

type TFn = ReturnType<typeof useTranslation>['t'];

function reasonLabel(reason: DirectoryReportReason, t: TFn): string {
  switch (reason) {
    case 'wrong_setup':
      return t('report.boardReasons.wrongSetup');
    case 'duplicate':
      return t('report.boardReasons.duplicate');
    case 'gone':
      return t('report.boardReasons.gone');
    case 'wrong_place':
      return t('report.boardReasons.wrongPlace');
    case 'relist_request':
      return t('reportReview.relistRequest');
    case 'closed':
      return t('report.gymReasons.closed');
    case 'wrong_details':
      return t('report.gymReasons.details');
    case 'not_a_gym':
      return t('report.gymReasons.home');
    case 'other':
      return t('report.boardReasons.other');
  }
}

export function ReportReviewSheet({
  board,
  viewerUserId,
  onClose,
  onAction,
}: {
  board: UserBoard;
  viewerUserId: string | null;
  onClose: () => void;
  onAction: (action: ReportReviewAction, board: UserBoard) => void;
}) {
  const { t, i18n } = useTranslation('boards');
  const { t: tCommon } = useTranslation('common');
  const { systemColors, brandColors } = useTheme();
  const { showToast } = useToast();
  const confirm = useConfirm();
  const setupSuggestionsEnabled = useDirectorySetupSuggestionsEnabled();
  const { data: reports, isLoading, isError } = useBoardReports(board.uuid);
  const resolve = useResolveDirectoryReport();
  const [step, setStep] = useState<'list' | 'keep'>('list');
  const [reply, setReply] = useState('');
  const refreshReportReads = useRefreshBoardReportReads();
  const [keeping, setKeeping] = useState(false);
  // How the last "It's right as it is" went when not every report closed:
  // none of them, or some (how many of how many).
  const [keepFailure, setKeepFailure] = useState<
    { kind: 'none' } | { kind: 'some'; closed: number; total: number } | null
  >(null);

  const waiting = useMemo(() => waitingReports(reports ?? []), [reports]);
  const keepable = useMemo(() => keepableReports(waiting), [waiting]);
  const notes = useMemo(() => reviewNotes(waiting), [waiting]);
  const { layoutId, sizeId, setIds, angle, boardType } = board;
  // The setups suggested on the waiting "Set up wrong" reports, one group per
  // setup, most suggested first. One the board already has is left out: there
  // is nothing to use.
  const suggestions = useMemo(() => {
    if (!setupSuggestionsEnabled) return [];
    const current = { layoutId, sizeId, setIds, angle };
    const notes = waiting
      .filter((report) => report.reason === SETUP_SUGGESTION_REPORT_REASON)
      .flatMap((report) => report.notes);
    return groupSuggestedSetups(notes).filter((group) => !setupMatches(group.setup, current));
  }, [setupSuggestionsEnabled, waiting, layoutId, sizeId, setIds, angle]);
  // The most suggested groups get a row each; the rest are one count below them.
  const shownSuggestions = useMemo(() => suggestions.slice(0, MAX_SUGGESTED_SETUPS_SHOWN), [suggestions]);
  const otherSuggestionCount = suggestions.length - shownSuggestions.length;
  // Each shown group's sentence, worked out once per list rather than per render.
  const suggestionLines = useMemo(
    () =>
      shownSuggestions.map((group) => ({
        group,
        text: t('mobile.setupSuggestion.suggested', {
          count: group.count,
          setup: formatSetupSummary(boardType, group.setup) ?? '',
        }),
      })),
    [shownSuggestions, boardType, t],
  );
  // "Use this setup" shows for each group to a viewer who can edit the board,
  // and only then does the edit route read "Edit it yourself" beside it.
  const offersUseSetup = board.canEdit === true && suggestionLines.length > 0;
  const footnote = reviewFootnote(waiting);
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const footnoteText =
    footnote?.kind === 'team_looking'
      ? t('reportReview.teamLooking')
      : footnote?.kind === 'team_date'
        ? (() => {
            const date = formatReviewDate(footnote.escalatesAt, locale);
            return date ? t('reportReview.teamDate', { date }) : null;
          })()
        : null;

  // "Use this setup": the edit screen's save, with its question when the owner
  // already has a board with this setup at this place.
  const { mutateAsync: updateBoardAsync } = useUpdateBoard();
  const applyChangedBoard = useApplyChangedBoard();
  const usingSetup = useRef(false);
  const [usingKey, setUsingKey] = useState<string | null>(null);
  const [useSetupFailed, setUseSetupFailed] = useState(false);
  // A "Use this setup" save is in flight: keep, remove, delete and the edit
  // route wait for it, so a report never closes as kept while its setup changes.
  const applyingSetup = usingKey !== null;

  // A swipe can't drop a save in flight: "It's right as it is" or "Use this setup".
  const guard = useUnsavedSheetGuard({
    visible: true,
    dirty: step === 'keep' && reply.trim().length > 0,
    busy: keeping || applyingSetup,
    onClose,
  });

  // The host's confirms are native alerts, which can't present over a sheet
  // that is still sliding away: the sheet goes first, then the action runs.
  const sheetRef = useRef<ManagedSheetHandle>(null);
  const acting = useRef(false);
  const act = useCallback(
    async (action: ReportReviewAction) => {
      if (acting.current || usingSetup.current) return;
      acting.current = true;
      await dismissManagedSheetAndWait(sheetRef.current);
      onClose();
      onAction(action, board);
    },
    [onClose, onAction, board],
  );
  const changeReply = useCallback((next: string) => setReply(next.slice(0, REPORT_NOTE_MAX_LENGTH)), []);
  const openKeepStep = useCallback(() => {
    if (usingSetup.current) return;
    setStep('keep');
  }, []);

  const applySuggestedSetup = useCallback(
    async (group: SuggestedSetupGroup) => {
      if (usingSetup.current || acting.current) return;
      usingSetup.current = true;
      setUsingKey(group.key);
      setUseSetupFailed(false);
      let allowDuplicateConfig = false;
      try {
        for (;;) {
          try {
            const updated = await updateBoardAsync(
              suggestedSetupUpdateInput(board.uuid, group.setup, { allowDuplicateConfig }),
            );
            try {
              await applyChangedBoard(updated);
            } catch {
              // Saved on the server; the active board heals on the next foreground.
            }
            refreshReportReads(board.uuid);
            showToast(t('reportReview.fixedToast'), 'success');
            onClose();
            return;
          } catch (error) {
            if (allowDuplicateConfig || !isDuplicateBoardError(error)) throw error;
            // Null whenever the viewer is not the board's owner: the server
            // keeps the other board's name and place from staff.
            const duplicate = readDuplicateBoardError(error);
            const saveAnyway = await confirm({
              title: t('mobile.edit.duplicate.title'),
              message: duplicate?.boardName
                ? duplicate.locationName
                  ? t('mobile.edit.duplicate.bodyWithLocation', {
                      name: duplicate.boardName,
                      location: duplicate.locationName,
                    })
                  : t('mobile.edit.duplicate.body', { name: duplicate.boardName })
                : t('mobile.edit.duplicate.bodyGeneric'),
              confirmLabel: t('mobile.edit.duplicate.saveAnyway'),
              cancelLabel: tCommon('actions.cancel'),
            });
            if (!saveAnyway) return;
            allowDuplicateConfig = true;
          }
        }
      } catch {
        setUseSetupFailed(true);
      } finally {
        usingSetup.current = false;
        setUsingKey(null);
      }
    },
    [updateBoardAsync, board.uuid, applyChangedBoard, refreshReportReads, showToast, t, tCommon, onClose, confirm],
  );
  const resolveAsync = resolve.mutateAsync;
  const sendKeep = useCallback(async () => {
    if (keeping || keepable.length === 0 || usingSetup.current) return;
    setKeeping(true);
    setKeepFailure(null);
    const note = normalizeReportNote(reply);
    try {
      // One report per reason; the climber answers them all with one note. Each
      // closes on its own, so one that fails (closed elsewhere a moment ago, a
      // dropped request) neither stops the others nor hides that they closed.
      const outcomes = await Promise.allSettled(
        keepable.map((report) => resolveAsync({ reportUuid: report.uuid, outcome: 'kept', note })),
      );
      const closed = outcomes.filter((outcome) => outcome.status === 'fulfilled').length;
      if (closed === outcomes.length) {
        showToast(t('reportReview.keptToast'), 'success');
        onClose();
      } else {
        // Stay on the note: Send again tries only what is still open, once the
        // refresh below has dropped the ones that closed.
        setKeepFailure(closed === 0 ? { kind: 'none' } : { kind: 'some', closed, total: outcomes.length });
      }
    } finally {
      // Whatever closed, re-read the board's reports and its report flags, so
      // the sheet and the lists show the state the server ended in.
      refreshReportReads(board.uuid);
      setKeeping(false);
    }
  }, [keeping, keepable, reply, resolveAsync, showToast, t, onClose, refreshReportReads, board.uuid]);

  const header =
    step === 'keep' ? (
      <SheetTopBar
        title={t('reportReview.keepTitle')}
        leading={{ kind: 'back', onPress: () => setStep('list') }}
        trailing={{
          kind: 'confirm',
          label: t('reportReview.keepSend'),
          onPress: () => void sendKeep(),
          disabled: keeping,
          loading: keeping,
          prominent: true,
        }}
      />
    ) : (
      <SheetTopBar title={board.name} leading={{ kind: 'close', onPress: guard.requestClose }} />
    );

  const isOwn = viewerUserId !== null && board.ownerId === viewerUserId;
  const gymName = board.gymName ?? '';
  const removeHint = isOwn
    ? t('reportReview.removeHintOwn')
    : board.ownerDisplayName
      ? t('reportReview.removeHintOther', { name: board.ownerDisplayName })
      : t('reportReview.removeHintOtherHidden');

  return (
    <ModalSheet
      ref={sheetRef}
      visible
      snapPoints={MEDIUM_LARGE_SNAP_POINTS}
      androidContentSized
      scrollable
      onDisplaced={onClose}
      onClose={guard.requestClose}
      onRequestClose={guard.requestClose}
      enablePanDownToClose={guard.enablePanDownToClose}
      contentContainerStyle={styles.body}
      header={header}
    >
      {step === 'keep' ? (
        <>
          <Text variant="subheadline" tone="secondary">
            {t('reportReview.keepReplyLabel')}
          </Text>
          <TickNoteField
            submitBehavior="newline"
            value={reply}
            onChangeText={changeReply}
            placeholder={t('reportReview.keepReplyPlaceholder')}
            accessibilityLabel={t('reportReview.keepReplyLabel')}
          />
          {keepFailure ? (
            <Text accessibilityLiveRegion="polite" color={brandColors.error} testID="report-review-keep-error">
              {keepFailure.kind === 'some'
                ? t('reportReview.keepPartial', { count: keepFailure.closed, total: keepFailure.total })
                : t('reportReview.keepError')}
            </Text>
          ) : null}
        </>
      ) : (
        <>
          <Text variant="headline" accessibilityRole="header">
            {t('reportReview.title')}
          </Text>
          {isLoading ? (
            <ActivityIndicator />
          ) : isError ? (
            <Text tone="secondary">{t('reportReview.loadError')}</Text>
          ) : waiting.length === 0 ? (
            <Text tone="secondary" testID="report-review-empty">
              {t('reportReview.nothingOpen')}
            </Text>
          ) : (
            <>
              <View style={styles.reasons}>
                {waiting.map((report: DirectoryReport) => (
                  <Text key={report.uuid} variant="body">
                    {t('reportReview.reasonCount', {
                      reason: reasonLabel(report.reason, t),
                      count: report.reporterCount,
                    })}
                  </Text>
                ))}
              </View>
              {suggestionLines.length > 0 ? (
                <View style={styles.reasons} testID="report-review-suggestions">
                  <Text variant="subheadline" tone="secondary" accessibilityRole="header">
                    {t('mobile.setupSuggestion.suggestedHeading')}
                  </Text>
                  {suggestionLines.map(({ group, text }) => (
                    <View key={group.key} style={styles.suggestion}>
                      <Text variant="body">{text}</Text>
                      {offersUseSetup ? (
                        <Button
                          title={t('mobile.setupSuggestion.useSetup')}
                          accessibilityLabel={t('mobile.setupSuggestion.useSetupLabel', {
                            setup: formatSetupSummary(boardType, group.setup) ?? '',
                          })}
                          variant="tonal"
                          size="small"
                          loading={usingKey === group.key}
                          disabled={applyingSetup}
                          onPress={() => void applySuggestedSetup(group)}
                          testID={`report-review-use-setup-${group.key}`}
                        />
                      ) : null}
                    </View>
                  ))}
                  {otherSuggestionCount > 0 ? (
                    <Text variant="body" tone="secondary" testID="report-review-other-suggestions">
                      {t('mobile.setupSuggestion.otherSuggested', { count: otherSuggestionCount })}
                    </Text>
                  ) : null}
                  {useSetupFailed ? (
                    <Text
                      accessibilityLiveRegion="polite"
                      color={brandColors.error}
                      testID="report-review-use-setup-error"
                    >
                      {t('reportReview.keepError')}
                    </Text>
                  ) : null}
                </View>
              ) : null}
              {notes.length > 0 ? (
                <View style={styles.reasons}>
                  <Text variant="subheadline" tone="secondary" accessibilityRole="header">
                    {t('reportReview.notesHeading')}
                  </Text>
                  {notes.map((note) => (
                    <Text key={note.key} variant="body">
                      {`“${note.note}”`}
                    </Text>
                  ))}
                </View>
              ) : null}
              {footnoteText ? (
                <Text variant="footnote" tone="secondary" testID="report-review-footnote">
                  {footnoteText}
                </Text>
              ) : null}
            </>
          )}
          <InsetGroupedList separatorInset="regular">
            {board.canEdit ? (
              <ReviewActionRow
                key="fix"
                icon="edit"
                label={offersUseSetup ? t('mobile.setupSuggestion.editYourself') : t('reportReview.fix')}
                hint={t('reportReview.fixHint')}
                color={systemColors.label}
                onPress={() => void act('fix')}
                disabled={applyingSetup}
                testID="report-review-fix"
              />
            ) : null}
            {board.canRemoveFromGym && gymName ? (
              <ReviewActionRow
                key="remove"
                icon="location"
                label={t('reportReview.remove', { gym: gymName })}
                hint={removeHint}
                color={systemColors.label}
                onPress={() => void act('remove')}
                disabled={applyingSetup}
                testID="report-review-remove"
              />
            ) : null}
            {board.canDelete ? (
              <ReviewActionRow
                key="delete"
                icon="delete"
                label={t('reportReview.delete')}
                hint={t('reportReview.deleteHint')}
                color={brandColors.error}
                onPress={() => void act('delete')}
                disabled={applyingSetup}
                testID="report-review-delete"
              />
            ) : null}
            {keepable.length > 0 ? (
              <ReviewActionRow
                key="keep"
                icon="check.small"
                label={t('reportReview.keep')}
                hint={t('reportReview.keepHint')}
                color={systemColors.label}
                onPress={openKeepStep}
                disabled={applyingSetup}
                testID="report-review-keep"
              />
            ) : null}
          </InsetGroupedList>
        </>
      )}
    </ModalSheet>
  );
}

function ReviewActionRow({
  icon,
  label,
  hint,
  color,
  onPress,
  disabled = false,
  testID,
}: {
  icon: IconName;
  label: string;
  hint: string;
  color: ColorValue;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
}) {
  const { systemColors } = useTheme();
  return (
    <PressableSurface
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      onPress={onPress}
      disabled={disabled}
      feedback="opacity"
      testID={testID}
      style={insetGroupedRowStyles.row}
    >
      <View style={insetGroupedRowStyles.leading}>
        <Icon name={icon} size={20} color={color} />
      </View>
      <View style={insetGroupedRowStyles.text}>
        <Text variant="body" color={color}>
          {label}
        </Text>
        <Text variant="footnote" color={systemColors.secondaryLabel}>
          {hint}
        </Text>
      </View>
    </PressableSurface>
  );
}

const styles = StyleSheet.create({
  body: { padding: spacing[4], gap: spacing[3] },
  reasons: { gap: spacing[1] },
  suggestion: { gap: spacing[2], alignItems: 'flex-start', paddingVertical: spacing[1] },
});
