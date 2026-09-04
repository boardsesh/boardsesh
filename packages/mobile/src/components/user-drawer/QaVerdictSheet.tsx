import { useCallback, useMemo, useRef, useState, type RefObject } from 'react';
import { StyleSheet, View } from 'react-native';
import { BottomSheetTextInput } from '@expo/ui/community/bottom-sheet';
import * as Updates from 'expo-updates';
import type { QaVerdictKind } from '@boardsesh/shared-schema';
import { useProfile } from '../../lib/graphql/hooks';
import { ModalSheet } from '../ModalSheet';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Button } from '../Button';
import { PressableSurface } from '../PressableSurface';
import { SegmentedControl } from '../SegmentedControl';
import { useTheme } from '../../providers/theme-provider';
import { useToast } from '../../providers/toast-provider';
import { spacing, borderRadius } from '../../theme/tokens';
import { setSetting } from '../../settings';
import { track } from '../../lib/analytics';
import { reportHandledError } from '../../lib/error-reporting';
import { qaSurfingAvailable, readRunningPrNumber, surfToProduction } from '../../lib/qa/qa-surf';
import { prBranchName } from '../../lib/qa/pr-branch';
import { qaSessionKey } from '../../lib/qa/qa-keys';
import { useQaPreviews, useSubmitQaVerdict } from '../../lib/qa/use-qa-previews';
import {
  QA_PREVIEW_LEFT_EVENT,
  QA_SURF_FAILED_EVENT,
  QA_VERDICT_SUBMITTED_EVENT,
  surfFailureReason,
} from '../../lib/qa/qa-analytics';
import type { ManagedSheetHandle } from '../../providers/sheet-presentation-provider';

// Tester-only surface: hardcoded English with `i18n-ignore`, like the other QA
// screens and the dev rows on the More tab.

// i18n-ignore-next-line — tester-only sheet
const SHEET_TITLE = 'How did it go?';
// i18n-ignore-next-line
const CLOSE_LABEL = 'Close';
// i18n-ignore-next-line
const APPROVE_LABEL = 'Approve';
// i18n-ignore-next-line
const DECLINE_LABEL = 'Decline';
// i18n-ignore-next-line
const VERDICT_GROUP_LABEL = 'Verdict';
// i18n-ignore-next-line
const APPROVE_PLACEHOLDER = 'Anything worth noting? (optional)';
// i18n-ignore-next-line
const DECLINE_PLACEHOLDER = 'What went wrong? Steps help.';
// i18n-ignore-next-line
const SUBMIT_LABEL = 'Send verdict';
// i18n-ignore-next-line
const LEAVE_LABEL = 'Leave preview without feedback';
// i18n-ignore-next-line
const SUBMIT_ERROR = 'Could not send that verdict — try again';
// i18n-ignore-next-line
const BACK_ON_PRODUCTION_TOAST = 'Back on production at the next update';
// Only the surf back failed; on the submit path the verdict has already landed
// and been toasted, so saying "could not send that verdict" here would be a lie
// about which half broke. The thrown message itself goes to Sentry and to the
// event's `reason` rather than into the tester's face.
// i18n-ignore-next-line
const LEAVE_FAILED_TOAST = 'Could not switch off this preview — try again';
// i18n-ignore-next-line
const NOT_ON_PREVIEW = "You're on production — nothing to file a verdict on.";
// i18n-ignore-next-line
const DEV_HINT = 'Surfing is unavailable in a dev build — the sheet will not switch back.';

const DECLINE_COMMENT_MIN_LENGTH = 10;
const COMMENT_MAX_LENGTH = 2000;

const VERDICT_OPTIONS: { key: QaVerdictKind; label: string }[] = [
  { key: 'approved', label: APPROVE_LABEL },
  { key: 'declined', label: DECLINE_LABEL },
];

type QaVerdictSheetProps = {
  sheetRef: RefObject<ManagedSheetHandle | null>;
};

/**
 * Approve or decline the PR preview this build is running, from the user drawer.
 *
 * Mounted at the `UserDrawerProvider` root beside `<FeedbackSheet />`, for the
 * same reason: @expo/ui native sheets present off the root window's view
 * controller, so one rendered inside the transparentModal drawer route would
 * present BEHIND it and stay hidden (#3211).
 *
 * Sending a verdict also takes the tester off the preview. That surf runs only
 * once the sheet is FULLY dismissed — a reload mid-dismissal would tear down a
 * live native presentation.
 */
export function QaVerdictSheet({ sheetRef }: QaVerdictSheetProps) {
  const { systemColors, brandColors } = useTheme();
  const { showToast } = useToast();
  const { mutateAsync, isPending } = useSubmitQaVerdict();

  const runningPrNumber = useMemo(() => readRunningPrNumber(), []);
  const prNumbers = useMemo(() => (runningPrNumber === null ? [] : [runningPrNumber]), [runningPrNumber]);
  // This sheet is mounted at the provider root for the whole app session, so its
  // query runs at launch whether or not anyone opens it. `qaPreviews` needs a
  // signed-in account, so gate on having one — otherwise every signed-out cold
  // start fires a request that can only be rejected.
  const { data: profile } = useProfile();
  const userId = profile?.id;
  const previewsQuery = useQaPreviews(prNumbers, { enabled: userId !== undefined });
  const preview = previewsQuery.data?.find((entry) => entry.prNumber === runningPrNumber) ?? null;

  const [verdict, setVerdict] = useState<QaVerdictKind>('approved');
  const [comment, setComment] = useState('');
  const surfingAvailable = qaSurfingAvailable();

  const trimmedComment = comment.trim();
  const remainingDeclineChars = Math.max(0, DECLINE_COMMENT_MIN_LENGTH - trimmedComment.length);
  // The account is part of the verdict, not decoration: `myLatestVerdict` is
  // per-caller and the "already signed off" marker is account-scoped, so filing
  // one before we know who is signed in would leave an unattributable marker.
  const canSubmit =
    runningPrNumber !== null && userId !== undefined && (verdict === 'approved' || remainingDeclineChars === 0);

  // Set before dismissing, read after the dismissal has really settled.
  const leaveAfterDismissRef = useRef(false);

  const leavePreview = useCallback(() => {
    if (!surfingAvailable) return;
    void surfToProduction()
      .then((outcome) => {
        // Production is not *newer* than a fresh pr-N bundle, so the running JS
        // usually stays put until production publishes again. The branch pin is
        // gone either way, which is the part that matters.
        if (outcome === 'nothing-to-load') showToast(BACK_ON_PRODUCTION_TOAST, 'info');
      })
      .catch((error: unknown) => {
        reportHandledError(error, { tags: { source: 'qa', op: 'surf-to-production' } });
        track(QA_SURF_FAILED_EVENT, { prNumber: null, reason: surfFailureReason(error) });
        showToast(LEAVE_FAILED_TOAST, 'error');
      });
  }, [showToast, surfingAvailable]);

  const handleFullyDismissed = useCallback(() => {
    if (!leaveAfterDismissRef.current) return;
    leaveAfterDismissRef.current = false;
    leavePreview();
  }, [leavePreview]);

  const handleSubmit = async () => {
    if (!canSubmit || isPending || runningPrNumber === null || userId === undefined) return;
    const branch = prBranchName(runningPrNumber);

    try {
      await mutateAsync({
        prNumber: runningPrNumber,
        branch,
        verdict,
        comment: trimmedComment.length > 0 ? trimmedComment : null,
      });
      // Written before the dismissal so a relaunch that beats the surf still
      // knows this bundle is signed off — leaving usually can't reload the app,
      // so the marker is what stops the gate re-prompting.
      setSetting('qaVerdictSubmittedKey', qaSessionKey(userId, branch, Updates.updateId));
      track(QA_VERDICT_SUBMITTED_EVENT, { prNumber: runningPrNumber, verdict, risk: preview?.risk ?? null });
      // i18n-ignore-next-line
      showToast(`Verdict sent to #${runningPrNumber}`, 'success');
      leaveAfterDismissRef.current = true;
      sheetRef.current?.dismiss();
      // The sheet lives at the provider root for the whole app session, so it is
      // never remounted — clearing here is what stops the next verdict opening
      // pre-filled with the last one.
      setVerdict('approved');
      setComment('');
    } catch (error) {
      reportHandledError(error, { tags: { source: 'qa', op: 'submit-verdict' } });
      showToast(SUBMIT_ERROR, 'error');
    }
  };

  const handleLeaveWithoutFeedback = () => {
    track(QA_PREVIEW_LEFT_EVENT, { prNumber: runningPrNumber });
    leaveAfterDismissRef.current = true;
    sheetRef.current?.dismiss();
  };

  const title = runningPrNumber === null ? SHEET_TITLE : `#${runningPrNumber} ${preview?.title ?? ''}`.trim();

  return (
    <ModalSheet
      ref={sheetRef}
      snapPoints={SNAP_POINTS}
      scrollable
      surface="solid"
      contentContainerStyle={styles.content}
      onFullyDismissed={handleFullyDismissed}
    >
      <View style={styles.headerRow}>
        <Text variant="title3" numberOfLines={2} style={styles.title}>
          {title}
        </Text>
        <PressableSurface
          onPress={() => sheetRef.current?.dismiss()}
          feedback="opacity"
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={CLOSE_LABEL}
          style={styles.closeButton}
        >
          <Icon name="close" size={20} color={systemColors.secondaryLabel} />
        </PressableSurface>
      </View>

      {runningPrNumber === null ? (
        <Text variant="subheadline" color={systemColors.secondaryLabel}>
          {NOT_ON_PREVIEW}
        </Text>
      ) : null}

      <SegmentedControl<QaVerdictKind>
        options={VERDICT_OPTIONS}
        selectedKey={verdict}
        onSelect={setVerdict}
        accessibilityLabel={VERDICT_GROUP_LABEL}
        tint={verdict === 'declined' ? brandColors.error : brandColors.success}
      />

      <BottomSheetTextInput
        style={[
          styles.input,
          {
            backgroundColor: systemColors.fill,
            borderColor: systemColors.separator,
            color: systemColors.label,
          },
        ]}
        placeholder={verdict === 'declined' ? DECLINE_PLACEHOLDER : APPROVE_PLACEHOLDER}
        placeholderTextColor={systemColors.tertiaryLabel}
        value={comment}
        onChangeText={setComment}
        multiline
        maxLength={COMMENT_MAX_LENGTH}
        textAlignVertical="top"
      />

      {verdict === 'declined' && remainingDeclineChars > 0 ? (
        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.helperText}>
          {/* i18n-ignore-next-line */}
          {`${remainingDeclineChars} more characters needed`}
        </Text>
      ) : null}

      {!surfingAvailable ? (
        <Text variant="footnote" color={systemColors.secondaryLabel}>
          {DEV_HINT}
        </Text>
      ) : null}

      <Button
        title={SUBMIT_LABEL}
        onPress={() => {
          void handleSubmit();
        }}
        variant="filled"
        size="large"
        disabled={!canSubmit}
        loading={isPending}
        style={styles.submitButton}
      />

      <Button
        title={LEAVE_LABEL}
        onPress={handleLeaveWithoutFeedback}
        variant="text"
        size="large"
        disabled={!surfingAvailable}
      />
    </ModalSheet>
  );
}

const SNAP_POINTS = ['58%', '86%'];

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[6],
    gap: spacing[4],
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing[3],
  },
  title: {
    flex: 1,
    fontWeight: '700',
  },
  closeButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  input: {
    minHeight: 116,
    maxHeight: 220,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: borderRadius.lg,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[3],
    fontSize: 16,
  },
  helperText: {
    marginTop: -spacing[2],
  },
  submitButton: {
    marginTop: spacing[1],
  },
});
