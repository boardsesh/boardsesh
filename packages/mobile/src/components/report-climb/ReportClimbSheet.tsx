// "Report climb" — the climber-facing half of community moderation. One form,
// two kinds: hide the climb (junk, duplicate, unclimbable) or argue its grade.
// Either way the server opens a proposal, joins the open one, or tells us this
// climber already reported it; the crew votes from the moderation feed.
//
// Controlled `visible` (mirrors AddBetaVideoSheet) so both hosts can drive it:
// the root DrawerHostProvider mounts one and clears its data on
// `onFullyDismissed`, and PlayDrawer mounts its own always-mounted copy inside
// the `/play` modal (a root sheet can't stack over it — #3505), which is why the
// form also resets on a false→true `visible` flip.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import * as Haptics from 'expo-haptics';
import type { BoardName, Climb } from '@boardsesh/shared-schema';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { ModalSheet } from '../ModalSheet';
import { Text } from '../Text';
import { SheetTopBar } from '../SheetTopBar';
import { SegmentedControl } from '../SegmentedControl';
import { ClimbPreviewCard } from '../ClimbPreviewCard';
import { GradeSingleSelectRail } from '../grade';
import { TickNoteField } from '../tick';
import { useReportClimb } from '../../lib/graphql/hooks/use-report-climb';
import { useGrades, useProfile } from '../../lib/graphql/hooks';
import { extractGraphqlMessage } from '../../lib/graphql/extract-error-message';
import { useTheme } from '../../providers/theme-provider';
import { useToast } from '../../providers/toast-provider';
import { track } from '../../lib/analytics';
import { spacing } from '../../theme/tokens';
import {
  REASON_MAX,
  buildReportInput,
  remainingReasonCharacters,
  reportToastCopy,
  type ReportKind,
} from './report-climb-form';
import { getDifficultyIdForGradeName } from '../../lib/grade-label';

type ReportClimbSheetProps = {
  visible: boolean;
  climb: Climb | null;
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
  /** Request an animated close (after a successful send, or the header X). */
  onClose: () => void;
  /** Fired once the dismiss animation has settled — safe to unmount/clear.
   *  Optional: always-mounted hosts (PlayDrawer) don't unmount, so they omit it. */
  onFullyDismissed?: () => void;
};

const SNAP_POINTS = ['62%', '88%'];

export function ReportClimbSheet({
  visible,
  climb,
  boardName,
  layoutId,
  sizeId,
  setIds,
  angle,
  onClose,
  onFullyDismissed,
}: ReportClimbSheetProps) {
  const { t } = useTranslation('climbs');
  const { systemColors, brandColors } = useTheme();
  const { showToast } = useToast();
  const [chosenKind, setKind] = useState<ReportKind>('hide');
  // Your own climb (only a spray wall offers Report there, #5971) is reported to
  // change its grade, never to hide it: the sheet locks to grade and hides the
  // segmented control. The server refuses a self-hide too.
  const { data: profile } = useProfile();
  const ownClimb = !!profile?.id && climb?.userId === profile.id;
  const kind: ReportKind = ownClimb ? 'grade' : chosenKind;
  const [reason, setReason] = useState('');
  // `TickNoteField` has no maxLength prop; the server bound is 500, enforced here.
  const handleChangeReason = useCallback((next: string) => setReason(next.slice(0, REASON_MAX)), []);
  // Null means "the climber hasn't touched the rail", which reads as the climb's
  // own grade — so the rail opens on the grade the report would argue against
  // rather than on nothing.
  const [pickedDifficultyId, setPickedDifficultyId] = useState<number | null>(null);

  const { mutate: sendReport, reset: resetReport, isPending, error: reportError } = useReportClimb();

  const { data: grades } = useGrades(boardName, visible && kind === 'grade');

  const resetForm = useCallback(() => {
    setKind('hide');
    setReason('');
    setPickedDifficultyId(null);
    resetReport();
  }, [resetReport]);

  // PlayDrawer keeps this sheet mounted forever, so a fresh open has to clear the
  // last report itself; the root host also gets `onFullyDismissed`, which clears
  // it once the dismiss animation has really settled.
  const wasVisibleRef = useRef(visible);
  useEffect(() => {
    const wasVisible = wasVisibleRef.current;
    wasVisibleRef.current = visible;
    if (visible && !wasVisible) resetForm();
  }, [visible, resetForm]);

  const handleFullyDismissed = useCallback(() => {
    resetForm();
    onFullyDismissed?.();
  }, [resetForm, onFullyDismissed]);

  const currentGradeName = climb?.difficulty ?? null;
  const gradeList = useMemo(() => grades ?? [], [grades]);
  const currentGrade = useMemo(() => {
    // Match by id too, so a differently-spelled label for the same grade still
    // lands on its chip (MoonBoard's 16 was "6a/V3" before it became "6a/V2").
    const currentDifficultyId = getDifficultyIdForGradeName(currentGradeName);
    return (
      gradeList.find((grade) => grade.name === currentGradeName || grade.difficultyId === currentDifficultyId) ?? null
    );
  }, [gradeList, currentGradeName]);
  const selectedDifficultyId = pickedDifficultyId ?? currentGrade?.difficultyId ?? null;
  const selectedGradeName = useMemo(
    () => gradeList.find((grade) => grade.difficultyId === selectedDifficultyId)?.name ?? null,
    [gradeList, selectedDifficultyId],
  );

  const isSameGrade =
    kind === 'grade' && selectedDifficultyId != null && selectedDifficultyId === currentGrade?.difficultyId;

  const kindOptions = useMemo(
    () => [
      { key: 'hide' as const, label: t('mobile.report.kind.hide') },
      { key: 'grade' as const, label: t('mobile.report.kind.grade') },
    ],
    [t],
  );

  const built = useMemo(() => {
    if (!climb) return null;
    return buildReportInput({
      kind,
      climbUuid: climb.uuid,
      boardType: boardName,
      angle,
      reason,
      selectedGradeName,
      currentGradeName,
    });
  }, [climb, kind, boardName, angle, reason, selectedGradeName, currentGradeName]);

  const handleSelectKind = useCallback((nextKind: ReportKind) => setKind(nextKind), []);
  const handleSelectGrade = useCallback((difficultyId: number | undefined) => {
    setPickedDifficultyId(difficultyId ?? null);
  }, []);

  const handleSubmit = useCallback(() => {
    if (!climb || isPending) return;
    if (!built || !built.ok) return;
    const { input } = built;
    sendReport(
      { input },
      {
        onSuccess: (result) => {
          track(SHARED_EVENTS.ClimbReported, { kind, boardType: boardName, status: result.status });
          // The success toast plays the haptic.
          const copy = reportToastCopy(result.status, kind, result.proposal);
          resetForm();
          // Toast AFTER the close request: a toast raised while the sheet is up
          // renders behind it and self-dismisses where nobody sees it.
          onClose();
          showToast(t(copy.textI18nKey, copy.params), 'success');
        },
        onError: () => {
          // No toast — the message renders inline, under the form that caused it.
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        },
      },
    );
  }, [climb, built, isPending, sendReport, kind, boardName, resetForm, onClose, showToast, t]);

  const remainingCharacters = remainingReasonCharacters(reason);
  const errorMessage = reportError ? (extractGraphqlMessage(reportError) ?? t('mobile.report.submitError')) : null;
  const submitDisabled = !built?.ok || isPending;

  const header = (
    <SheetTopBar
      title={t('mobile.report.title')}
      leading={{ kind: 'cancel', onPress: onClose }}
      trailing={{
        label: t('mobile.report.submit'),
        onPress: handleSubmit,
        disabled: submitDisabled,
        loading: isPending,
        prominent: true,
      }}
      error={errorMessage}
      reserveErrorSlot
    />
  );

  return (
    <ModalSheet
      visible={visible && !!climb}
      snapPoints={SNAP_POINTS}
      scrollable
      surface="solid"
      androidContentSized
      onClose={onClose}
      onFullyDismissed={handleFullyDismissed}
      header={header}
    >
      {climb ? (
        <ClimbPreviewCard
          climb={climb}
          boardName={boardName}
          layoutId={layoutId}
          sizeId={sizeId}
          setIds={setIds}
          angle={angle}
        />
      ) : null}

      <View style={styles.body}>
        {ownClimb ? null : (
          <SegmentedControl
            options={kindOptions}
            selectedKey={kind}
            onSelect={handleSelectKind}
            accessibilityLabel={t('mobile.report.kind.label')}
            tint={brandColors.primaryFill}
          />
        )}
        <Text variant="footnote" color={systemColors.secondaryLabel}>
          {kind === 'hide' ? t('mobile.report.kind.hideHint') : t('mobile.report.kind.gradeHint')}
        </Text>

        {kind === 'grade' ? (
          <View style={styles.gradeRail}>
            <GradeSingleSelectRail
              grades={gradeList}
              selectedDifficultyId={selectedDifficultyId}
              consensusDifficultyId={currentGrade?.difficultyId ?? null}
              boardName={boardName}
              onSelect={handleSelectGrade}
              allowClear={false}
              colorway="selection"
              contentInsetLeft={0}
              contentInsetRight={spacing[4]}
            />
            {isSameGrade ? (
              <Text variant="footnote" color={systemColors.secondaryLabel}>
                {t('mobile.report.sameGrade')}
              </Text>
            ) : null}
          </View>
        ) : null}

        {/* The shared tick note field, not a raw input: it caps itself at 160pt
            because the iOS keyboard-up sheet body is only ~162pt — a field
            taller than the visible body can never scroll fully into view, and
            the Send action's bar ends up over it (QA-declined on #5188). Its vertical
            padding is load-bearing on Android (#4642); see the component. */}
        <TickNoteField
          value={reason}
          onChangeText={handleChangeReason}
          placeholder={t('mobile.report.reasonPlaceholder')}
          accessibilityLabel={t('mobile.report.reasonAria')}
        />
        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.counter}>
          {remainingCharacters > 0
            ? t('mobile.report.reasonRemaining', { count: remainingCharacters })
            : t('mobile.report.reasonCount', { count: reason.length })}
        </Text>
      </View>
    </ModalSheet>
  );
}

const styles = StyleSheet.create({
  body: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    paddingBottom: spacing[6],
    gap: spacing[3],
  },
  gradeRail: {
    gap: spacing[2],
  },
  counter: {
    marginTop: -spacing[2],
  },
});
