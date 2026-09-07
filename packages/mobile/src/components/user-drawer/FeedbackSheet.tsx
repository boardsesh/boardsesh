import { useEffect, useMemo, useState, type RefObject } from 'react';
import { StyleSheet, View } from 'react-native';
import { BottomSheetTextInput } from '@expo/ui/community/bottom-sheet';
import { useTranslation } from 'react-i18next';
import { ModalSheet } from '../ModalSheet';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Button } from '../Button';
import { PressableSurface } from '../PressableSurface';
import { ScreenshotPicker } from '../feedback/ScreenshotPicker';
import { SessionRecordingSwitchRow } from '../settings/SessionRecordingSwitchRow';
import { SwitchRow } from '../SwitchRow';
import { useAuth } from '../../providers/auth-provider';
import { useTheme } from '../../providers/theme-provider';
import { useToast } from '../../providers/toast-provider';
import { spacing, borderRadius } from '../../theme/tokens';
import { reportHandledError } from '../../lib/error-reporting';
import { useSubmitMobileAppFeedback } from '../../lib/feedback/use-submit-app-feedback';
import { clearScreenshotUploadCache, uploadFeedbackScreenshots } from '../../lib/feedback/screenshot-upload';
import { runBleAdvertisementRecon } from '../../lib/ble/advertisement-recon';
import { openDiscordInvite } from '../../lib/discord';
import type { ManagedSheetHandle } from '../../providers/sheet-presentation-provider';

export type FeedbackSheetMode = 'rating' | 'bug';

const BUG_COMMENT_MIN_LENGTH = 10;
const COMMENT_MAX_LENGTH = 2000;
const STAR_RATING_VALUES = [1, 2, 3, 4, 5] as const;

type FeedbackSheetProps = {
  sheetRef: RefObject<ManagedSheetHandle | null>;
  mode: FeedbackSheetMode;
  /**
   * Show a "Join Discord" link below the submit button. Used on the login screen,
   * where a stuck user has no other route to help; off everywhere else (the user
   * drawer already has its own Discord row).
   */
  showDiscordLink?: boolean;
};

export function FeedbackSheet({ sheetRef, mode, showDiscordLink = false }: FeedbackSheetProps) {
  const { t } = useTranslation('settings');
  // The screenshot strings live in `common`, shared with the QA verdict sheet.
  const { t: tCommon } = useTranslation('common');
  const { systemColors, brandColors } = useTheme();
  const { showToast } = useToast();
  const { isAuthenticated } = useAuth();
  const { mutateAsync, isPending, reset } = useSubmitMobileAppFeedback();
  const [selectedRating, setSelectedRating] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [captureBleDiag, setCaptureBleDiag] = useState(false);
  const [contactConsent, setContactConsent] = useState(true);
  const [screenshotUris, setScreenshotUris] = useState<string[]>([]);
  const [isUploading, setIsUploading] = useState(false);

  const isBugReport = mode === 'bug';
  // The upload endpoint needs a bearer token, so a signed-out reporter gets the
  // existing text-only form rather than a picker that could only fail on submit.
  const canAttachScreenshots = isBugReport && isAuthenticated;
  const trimmedComment = comment.trim();
  const remainingBugChars = Math.max(0, BUG_COMMENT_MIN_LENGTH - trimmedComment.length);
  const canSubmit = isBugReport ? remainingBugChars === 0 : selectedRating !== null;
  const title = isBugReport ? t('feedbackDialog.titleBug') : t('feedbackDialog.titleRating');
  const submitLabel = isBugReport ? t('feedbackDialog.submitBug') : t('feedbackDialog.submitRating');
  const inputPlaceholder = isBugReport ? t('feedbackForm.bugPlaceholder') : t('feedbackForm.ratingPlaceholder');

  useEffect(() => {
    setSelectedRating(null);
    setComment('');
    setCaptureBleDiag(false);
    setContactConsent(true);
    setScreenshotUris([]);
    reset();
  }, [mode, reset]);

  const snapPoints = useMemo(() => (isBugReport ? ['62%', '88%'] : ['44%', '72%']), [isBugReport]);

  const handleDismiss = () => {
    sheetRef.current?.dismiss();
  };

  const handleSubmit = async () => {
    if (!canSubmit || isPending || isUploading) return;

    // Uploaded before the report so it carries keys the backend can resolve. A
    // failed upload leaves the typed report and the picked shots untouched.
    let screenshotKeys: string[] = [];
    if (screenshotUris.length > 0) {
      setIsUploading(true);
      try {
        screenshotKeys = await uploadFeedbackScreenshots(screenshotUris);
      } catch (error) {
        // An upload failure the reporter can see must also be one we can see.
        reportHandledError(error, { tags: { source: 'feedback', op: 'upload-screenshots' } });
        showToast(tCommon('screenshots.uploadFailed'), 'error');
        return;
      } finally {
        setIsUploading(false);
      }
    }

    try {
      // Fire the opt-in Bluetooth scan-recon alongside the report. It scans
      // (no connect) and ships each in-range board's raw advertisement payload
      // to PostHog so we can find where bare-name boxes stash their serial. The
      // correlation id groups this one scan's events; joining to the specific bug
      // report is by person + timestamp (the report goes to the backend, not
      // PostHog). Runs independently of the sheet lifecycle; never blocks the
      // submit or surfaces its own errors.
      if (isBugReport && captureBleDiag) {
        const reconCorrelationId = `bug-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
        void runBleAdvertisementRecon(reconCorrelationId).catch(() => {});
      }
      await mutateAsync({
        source: isBugReport ? 'drawer-bug' : 'drawer-feedback',
        rating: isBugReport ? null : selectedRating,
        comment: trimmedComment.length > 0 ? trimmedComment : null,
        contactConsent: isBugReport ? contactConsent : null,
        screenshotKeys: screenshotKeys.length > 0 ? screenshotKeys : null,
      });
      sheetRef.current?.dismiss();
      showToast(isBugReport ? t('feedbackDialog.successBug') : t('feedbackDialog.successRating'), 'success');
      setSelectedRating(null);
      setComment('');
      setContactConsent(true);
      setScreenshotUris([]);
      // The report is filed, so the uploaded objects now belong to it. The next
      // one must upload its own rather than reuse these.
      clearScreenshotUploadCache();
    } catch (error) {
      reportHandledError(error, { tags: { source: 'feedback', op: 'submit-report' } });
      showToast(t('feedbackDialog.errorRating'), 'error');
    }
  };

  return (
    <ModalSheet ref={sheetRef} snapPoints={snapPoints} scrollable contentContainerStyle={styles.content}>
      <View style={styles.headerRow}>
        <Text variant="title3" style={styles.title}>
          {title}
        </Text>
        <PressableSurface
          onPress={handleDismiss}
          feedback="opacity"
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('feedbackDialog.closeAria')}
          style={styles.closeButton}
        >
          <Icon name="close" size={20} color={systemColors.secondaryLabel} />
        </PressableSurface>
      </View>

      {!isBugReport ? (
        <View style={styles.starRow}>
          {STAR_RATING_VALUES.map((starRating) => {
            const selected = selectedRating !== null && starRating <= selectedRating;
            return (
              <PressableSurface
                key={starRating}
                onPress={() => setSelectedRating(starRating)}
                feedback="scale"
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel={t('feedbackForm.starRating', { count: starRating })}
                accessibilityState={{ selected }}
                style={styles.starButton}
              >
                <Icon name={selected ? 'star.fill' : 'star'} size={34} color={brandColors.warning} />
              </PressableSurface>
            );
          })}
        </View>
      ) : null}

      <BottomSheetTextInput
        style={[
          styles.input,
          {
            backgroundColor: systemColors.fill,
            borderColor: systemColors.separator,
            color: systemColors.label,
          },
        ]}
        placeholder={inputPlaceholder}
        placeholderTextColor={systemColors.tertiaryLabel}
        value={comment}
        onChangeText={setComment}
        multiline
        maxLength={COMMENT_MAX_LENGTH}
        textAlignVertical="top"
      />

      {isBugReport && remainingBugChars > 0 ? (
        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.helperText}>
          {t('feedbackForm.remainingChars', { count: remainingBugChars })}
        </Text>
      ) : null}

      {isBugReport ? (
        <View style={[styles.recordingCard, { backgroundColor: systemColors.secondaryBackground }]}>
          <SessionRecordingSwitchRow
            label={t('feedbackForm.sessionRecordingLabel')}
            description={t('feedbackForm.sessionRecordingDescription')}
          />
          <SwitchRow
            label={t('feedbackForm.bluetoothBugLabel')}
            description={t('feedbackForm.bluetoothBugDescription')}
            value={captureBleDiag}
            onValueChange={setCaptureBleDiag}
          />
        </View>
      ) : null}

      {canAttachScreenshots ? (
        <ScreenshotPicker uris={screenshotUris} onChange={setScreenshotUris} disabled={isPending || isUploading} />
      ) : null}

      {isBugReport && isAuthenticated ? (
        <View style={[styles.recordingCard, { backgroundColor: systemColors.secondaryBackground }]}>
          <SwitchRow
            label={t('feedbackForm.contactConsentLabel')}
            description={t('feedbackForm.contactConsentDescription')}
            value={contactConsent}
            onValueChange={setContactConsent}
          />
        </View>
      ) : null}

      <Button
        title={submitLabel}
        onPress={() => {
          void handleSubmit();
        }}
        variant="filled"
        size="large"
        disabled={!canSubmit || isUploading}
        loading={isPending || isUploading}
        style={styles.submitButton}
      />

      {showDiscordLink ? (
        <Button
          title={t('feedbackDialog.joinDiscord')}
          onPress={() => {
            void openDiscordInvite('login');
          }}
          variant="text"
          size="large"
          icon="open.external"
          tintColor={brandColors.primary}
        />
      ) : null}
    </ModalSheet>
  );
}

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
  starRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: spacing[2],
  },
  starButton: {
    width: 44,
    height: 44,
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
  recordingCard: {
    overflow: 'hidden',
    borderRadius: borderRadius.lg,
  },
  submitButton: {
    marginTop: spacing[1],
  },
});
