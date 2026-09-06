import { useCallback, useMemo, useRef, useState, type RefObject } from 'react';
import { StyleSheet, View } from 'react-native';
import { BottomSheetTextInput } from '@expo/ui/community/bottom-sheet';
import * as Updates from 'expo-updates';
import { useTranslation } from 'react-i18next';
import type { QaVerdictKind } from '@boardsesh/shared-schema';
import { useProfile } from '../../lib/graphql/hooks';
import { ModalSheet } from '../ModalSheet';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Button } from '../Button';
import { PressableSurface } from '../PressableSurface';
import { ScreenshotPicker } from '../feedback/ScreenshotPicker';
import { SegmentedControl } from '../SegmentedControl';
import { useTheme } from '../../providers/theme-provider';
import { useToast } from '../../providers/toast-provider';
import { spacing, borderRadius } from '../../theme/tokens';
import { setSetting } from '../../settings';
import { track } from '../../lib/analytics';
import { reportHandledError } from '../../lib/error-reporting';
import { clearScreenshotUploadCache, uploadFeedbackScreenshots } from '../../lib/feedback/screenshot-upload';
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

// This sheet was tester-only (hardcoded English, like the other QA screens and
// the dev rows on the More tab) until it opened to every user in #5126.
// `DEV_HINT` is the one string left English-only: it's a dev-build-only hint
// no shipped user ever sees.

// i18n-ignore-next-line — dev-build-only hint, never shown in a shipped build
const DEV_HINT = 'Surfing is unavailable in a dev build — the sheet will not switch back.';

const DECLINE_COMMENT_MIN_LENGTH = 10;
const COMMENT_MAX_LENGTH = 2000;

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
  const { t } = useTranslation('common');
  const { systemColors, brandColors } = useTheme();
  const { showToast } = useToast();
  const { mutateAsync, isPending } = useSubmitQaVerdict();

  const verdictOptions = useMemo<{ key: QaVerdictKind; label: string }[]>(
    () => [
      { key: 'approved', label: t('qa.verdict.approveLabel') },
      { key: 'declined', label: t('qa.verdict.declineLabel') },
    ],
    [t],
  );

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
  const [screenshotUris, setScreenshotUris] = useState<string[]>([]);
  const [isUploading, setIsUploading] = useState(false);
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
        if (outcome === 'nothing-to-load') showToast(t('qa.shared.backOnProduction'), 'info');
      })
      .catch((error: unknown) => {
        reportHandledError(error, { tags: { source: 'qa', op: 'surf-to-production' } });
        track(QA_SURF_FAILED_EVENT, { prNumber: null, reason: surfFailureReason(error) });
        // Only the surf back failed; on the submit path the verdict has already
        // landed and been toasted, so saying "could not send that verdict" here
        // would be a lie about which half broke. The thrown message itself goes
        // to Sentry and to the event's `reason` rather than into the tester's face.
        showToast(t('qa.shared.leaveFailed'), 'error');
      });
  }, [showToast, surfingAvailable, t]);

  const handleFullyDismissed = useCallback(() => {
    if (!leaveAfterDismissRef.current) return;
    leaveAfterDismissRef.current = false;
    leavePreview();
  }, [leavePreview]);

  const handleSubmit = async () => {
    if (!canSubmit || isPending || isUploading || runningPrNumber === null || userId === undefined) return;
    const branch = prBranchName(runningPrNumber);

    // Uploaded before the verdict so the mutation carries keys the backend can
    // resolve. A failed upload keeps the typed comment and the picked shots on
    // screen — the tester retries rather than retypes.
    let screenshotKeys: string[] = [];
    if (screenshotUris.length > 0) {
      setIsUploading(true);
      try {
        screenshotKeys = await uploadFeedbackScreenshots(screenshotUris);
      } catch (error) {
        reportHandledError(error, { tags: { source: 'qa', op: 'upload-screenshots' } });
        showToast(t('screenshots.uploadFailed'), 'error');
        return;
      } finally {
        setIsUploading(false);
      }
    }

    try {
      await mutateAsync({
        prNumber: runningPrNumber,
        branch,
        verdict,
        comment: trimmedComment.length > 0 ? trimmedComment : null,
        // null, not [], for "none" — the same shape FeedbackSheet sends down the
        // same path, and the same shape the column stores.
        screenshotKeys: screenshotKeys.length > 0 ? screenshotKeys : null,
      });
      // Written before the dismissal so a relaunch that beats the surf still
      // knows this bundle is signed off — leaving usually can't reload the app,
      // so the marker is what stops the gate re-prompting.
      setSetting('qaVerdictSubmittedKey', qaSessionKey(userId, branch, Updates.updateId));
      track(QA_VERDICT_SUBMITTED_EVENT, { prNumber: runningPrNumber, verdict, risk: preview?.risk ?? null });
      showToast(t('qa.verdict.verdictSentToast', { prNumber: runningPrNumber }), 'success');
      leaveAfterDismissRef.current = true;
      sheetRef.current?.dismiss();
      // The sheet lives at the provider root for the whole app session, so it is
      // never remounted — clearing here is what stops the next verdict opening
      // pre-filled with the last one.
      setVerdict('approved');
      setComment('');
      setScreenshotUris([]);
      // The verdict is filed, so the uploaded objects now belong to it. The next
      // one must upload its own rather than reuse these.
      clearScreenshotUploadCache();
    } catch (error) {
      reportHandledError(error, { tags: { source: 'qa', op: 'submit-verdict' } });
      showToast(t('qa.verdict.submitError'), 'error');
    }
  };

  const handleLeaveWithoutFeedback = () => {
    track(QA_PREVIEW_LEFT_EVENT, { prNumber: runningPrNumber });
    leaveAfterDismissRef.current = true;
    sheetRef.current?.dismiss();
  };

  const title =
    runningPrNumber === null ? t('qa.verdict.sheetTitle') : `#${runningPrNumber} ${preview?.title ?? ''}`.trim();

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
          accessibilityLabel={t('actions.close')}
          style={styles.closeButton}
        >
          <Icon name="close" size={20} color={systemColors.secondaryLabel} />
        </PressableSurface>
      </View>

      {runningPrNumber === null ? (
        <Text variant="subheadline" color={systemColors.secondaryLabel}>
          {t('qa.verdict.notOnPreview')}
        </Text>
      ) : null}

      <SegmentedControl<QaVerdictKind>
        options={verdictOptions}
        selectedKey={verdict}
        onSelect={setVerdict}
        accessibilityLabel={t('qa.verdict.verdictGroupLabel')}
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
        placeholder={verdict === 'declined' ? t('qa.verdict.declinePlaceholder') : t('qa.verdict.approvePlaceholder')}
        placeholderTextColor={systemColors.tertiaryLabel}
        value={comment}
        onChangeText={setComment}
        multiline
        maxLength={COMMENT_MAX_LENGTH}
        textAlignVertical="top"
      />

      <ScreenshotPicker uris={screenshotUris} onChange={setScreenshotUris} disabled={isPending || isUploading} />

      {verdict === 'declined' && remainingDeclineChars > 0 ? (
        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.helperText}>
          {t('qa.verdict.moreCharsNeeded', { count: remainingDeclineChars })}
        </Text>
      ) : null}

      {!surfingAvailable ? (
        <Text variant="footnote" color={systemColors.secondaryLabel}>
          {DEV_HINT}
        </Text>
      ) : null}

      <Button
        title={t('qa.verdict.submitLabel')}
        onPress={() => {
          void handleSubmit();
        }}
        variant="filled"
        size="large"
        disabled={!canSubmit || isUploading}
        loading={isPending || isUploading}
        style={styles.submitButton}
      />

      <Button
        title={t('qa.verdict.leaveLabel')}
        onPress={handleLeaveWithoutFeedback}
        variant="text"
        size="large"
        disabled={!surfingAvailable}
      />
    </ModalSheet>
  );
}

const SNAP_POINTS = ['64%', '90%'];

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
