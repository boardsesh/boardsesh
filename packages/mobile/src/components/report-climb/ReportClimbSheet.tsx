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
import { Icon } from '../Icon';
import { Button } from '../Button';
import { PressableSurface } from '../PressableSurface';
import { SegmentedControl } from '../SegmentedControl';
import { ClimbPreviewCard } from '../ClimbPreviewCard';
import { GradeSingleSelectRail } from '../grade';
import { TickNoteField } from '../tick';
import { useReportClimb } from '../../lib/graphql/hooks/use-report-climb';
import { useGrades } from '../../lib/graphql/hooks';
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
  const [kind, setKind] = useState<ReportKind>('hide');
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
  const currentGrade = useMemo(
    () => gradeList.find((grade) => grade.name === currentGradeName) ?? null,
    [gradeList, currentGradeName],
  );
  const selectedDifficultyId = pickedDifficultyId ?? currentGrade?.difficultyId ?? null;
  const selectedGradeName = useMemo(
    () => gradeList.find((grade) => grade.difficultyId === selectedDifficultyId)?.name ?? null,
    [gradeList, selectedDifficultyId],
  );

  const isSameGrade = kind === 'grade' && !!selectedGradeName && selectedGradeName === currentGradeName;

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
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
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
    <View style={styles.header}>
      <Text variant="title3" style={styles.headerTitle}>
        {t('mobile.report.title')}
      </Text>
      <PressableSurface
        onPress={onClose}
        feedback="opacity"
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={t('mobile.report.close')}
        style={styles.closeButton}
      >
        <Icon name="close" size={20} color={systemColors.secondaryLabel} />
      </PressableSurface>
    </View>
  );

  const footer = (
    <View style={styles.footer}>
      {errorMessage ? (
        <Text variant="footnote" color={brandColors.error}>
          {errorMessage}
        </Text>
      ) : null}
      <Button
        title={t('mobile.report.submit')}
        onPress={handleSubmit}
        variant="filled"
        size="large"
        disabled={submitDisabled}
        loading={isPending}
      />
    </View>
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
      footer={footer}
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
        <SegmentedControl
          options={kindOptions}
          selectedKey={kind}
          onSelect={handleSelectKind}
          accessibilityLabel={t('mobile.report.kind.label')}
          tint={brandColors.primaryFill}
        />
        <Text variant="footnote" color={systemColors.secondaryLabel}>
          {kind === 'hide' ? t('mobile.report.kind.hideHint') : t('mobile.report.kind.gradeHint')}
        </Text>

        {kind === 'grade' ? (
          <View style={styles.gradeRail}>
            <GradeSingleSelectRail
              grades={gradeList}
              selectedDifficultyId={selectedDifficultyId}
              consensusDifficultyId={currentGrade?.difficultyId ?? null}
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
            the pinned Send bar ends up over it (QA-declined on #5188). Its vertical
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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
  },
  headerTitle: {
    flex: 1,
    fontWeight: '700',
  },
  closeButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
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
  footer: {
    gap: spacing[2],
  },
});
