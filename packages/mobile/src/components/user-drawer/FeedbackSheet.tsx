import { MEDIUM_LARGE_SNAP_POINTS } from '../sheet-snap-points';
import { useScopedSheetError } from '../../hooks/use-scoped-sheet-error';
import { InlineSheetError } from '../InlineSheetError';
import { useUnsavedSheetGuard } from '../../hooks/use-unsaved-sheet-guard';
import { memo, useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { AccessibleBottomSheetTextInput as BottomSheetTextInput } from '../AccessibleBottomSheetTextInput';
import { StyleSheet } from 'react-native';

import { useTranslation } from 'react-i18next';
import { ModalSheet } from '../ModalSheet';
import { SheetTopBar } from '../SheetTopBar';
import { useAuth } from '../../providers/auth-provider';
import { useToast } from '../../providers/toast-provider';
import { spacing } from '../../theme/tokens';
import { FeedbackMetadataCollector, type FeedbackMetadataReader } from '../../lib/feedback/FeedbackMetadataCollector';
import { useSubmitMobileAppFeedback } from '../../lib/feedback/use-submit-app-feedback';
import { uploadFeedbackAttachments } from '../../lib/feedback/attachment-upload';
import type { FeedbackAttachment } from '../../lib/feedback/shared-bug-draft.types';
import { readLocalUserId } from '../../lib/local-user-id';
import { FeedbackForm, BUG_COMMENT_MIN_LENGTH } from '../feedback/FeedbackForm';
import { runBleAdvertisementRecon } from '../../lib/ble/advertisement-recon';
import type { ManagedSheetHandle } from '../../providers/sheet-presentation-provider';

export type FeedbackSheetMode = 'rating' | 'bug';

type FeedbackSheetProps = {
  sheetRef: RefObject<ManagedSheetHandle | null>;
  mode: FeedbackSheetMode;
  visible: boolean;
  onClose: () => void;
  /**
   * Show a "Join Discord" link below the submit button. Used on the login screen,
   * where a stuck user has no other route to help; off everywhere else (the user
   * drawer already has its own Discord row).
   */
  showDiscordLink?: boolean;
};

export const FeedbackSheet = memo(function FeedbackSheet({
  sheetRef,
  mode,
  visible,
  onClose,
  showDiscordLink = false,
}: FeedbackSheetProps) {
  const { t } = useTranslation('settings');
  // The screenshot strings live in `common`, shared with the QA verdict sheet.
  const { t: tCommon } = useTranslation('common');
  const { showToast } = useToast();
  const { isAuthenticated } = useAuth();
  const metadataReaderRef = useRef<FeedbackMetadataReader | null>(null);
  const { mutateAsync, isPending, reset } = useSubmitMobileAppFeedback(metadataReaderRef);
  const [selectedRating, setSelectedRating] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [captureBleDiag, setCaptureBleDiag] = useState(false);
  const [contactConsent, setContactConsent] = useState(true);
  const [attachments, setAttachments] = useState<FeedbackAttachment[]>([]);
  const uploadedKeysRef = useRef<Record<string, string>>({});
  const uploadAccountRef = useRef<string | undefined>(undefined);
  const [isUploading, setIsUploading] = useState(false);
  const [isPickingAttachments, setIsPickingAttachments] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const isBugReport = mode === 'bug';
  const trimmedComment = comment.trim();
  const remainingBugChars = Math.max(0, BUG_COMMENT_MIN_LENGTH - trimmedComment.length);
  const canSubmit = isBugReport ? remainingBugChars === 0 : selectedRating !== null;
  const title = isBugReport ? t('feedbackDialog.titleBug') : t('feedbackDialog.titleRating');
  const submitLabel = isBugReport ? t('feedbackDialog.submitBug') : t('feedbackDialog.submitRating');

  const { submitError, setSubmitError, clearError } = useScopedSheetError(mode, visible);
  const resetForm = useCallback(() => {
    setSelectedRating(null);
    setComment('');
    setCaptureBleDiag(false);
    setContactConsent(true);
    setAttachments([]);
    uploadedKeysRef.current = {};
    uploadAccountRef.current = undefined;
    clearError();
    reset();
  }, [reset, clearError]);
  useEffect(resetForm, [mode, resetForm]);

  const dirty =
    selectedRating !== null || comment.length > 0 || captureBleDiag || !contactConsent || attachments.length > 0;
  const guard = useUnsavedSheetGuard({
    visible,
    dirty,
    busy: isSubmitting || isPending || isUploading || isPickingAttachments,
    onClose,
    onDiscard: resetForm,
    scope: mode,
  });

  const snapPoints = MEDIUM_LARGE_SNAP_POINTS;

  const handleSubmit = async () => {
    if (!canSubmit || submittingRef.current || isPickingAttachments) return;
    submittingRef.current = true;
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      // Uploaded before the report so it carries keys the backend can resolve. A
      // failed upload leaves the typed report and the picked shots untouched.
      let screenshotKeys: string[] = [];
      let recordingKeys: string[] = [];
      if (attachments.length > 0) {
        setIsUploading(true);
        try {
          const accountId = await readLocalUserId();
          if (!accountId) throw new Error('Sign in before attaching media');
          if (accountId !== uploadAccountRef.current) uploadedKeysRef.current = {};
          uploadAccountRef.current = accountId;
          const uploaded = await uploadFeedbackAttachments(attachments, uploadedKeysRef.current, async (uri, key) => {
            if ((await readLocalUserId()) !== accountId) throw new Error('Account changed during upload');
            uploadedKeysRef.current = { ...uploadedKeysRef.current, [uri]: key };
          });
          if ((await readLocalUserId()) !== accountId) throw new Error('Account changed during upload');
          screenshotKeys = uploaded.screenshotKeys;
          recordingKeys = uploaded.recordingKeys;
        } catch {
          setSubmitError(tCommon('feedbackAttachments.uploadFailed'));
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
          recordingKeys: recordingKeys.length > 0 ? recordingKeys : null,
        });
        onClose();
        showToast(isBugReport ? t('feedbackDialog.successBug') : t('feedbackDialog.successRating'), 'success');
        setSelectedRating(null);
        setComment('');
        setContactConsent(true);
        setAttachments([]);
        // The report is filed, so the uploaded objects now belong to it. The next
        // one must upload its own rather than reuse these.
        uploadedKeysRef.current = {};
        uploadAccountRef.current = undefined;
      } catch {
        setSubmitError(t('feedbackDialog.errorRating'));
      }
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  return (
    <>
      {visible || isSubmitting ? <FeedbackMetadataCollector readerRef={metadataReaderRef} /> : null}
      <ModalSheet
        ref={sheetRef}
        visible={visible}
        onDisplaced={onClose}
        onClose={guard.requestClose}
        enablePanDownToClose={guard.enablePanDownToClose}
        snapPoints={snapPoints}
        scrollable
        contentContainerStyle={styles.content}
        header={
          <SheetTopBar
            title={title}
            leading={{ kind: 'cancel', onPress: guard.requestClose }}
            trailing={{
              kind: 'send',
              label: submitLabel,
              onPress: () => {
                void handleSubmit();
              },
              disabled: !canSubmit || isSubmitting || isPending || isUploading || isPickingAttachments,
              loading: isSubmitting || isPending || isUploading,
              prominent: true,
            }}
          />
        }
      >
        <InlineSheetError message={submitError} visible={visible} scope={mode} />
        <FeedbackForm
          mode={mode}
          InputComponent={BottomSheetTextInput}
          isAuthenticated={isAuthenticated}
          disabled={isSubmitting || isPending || isUploading}
          selectedRating={selectedRating}
          onRatingChange={setSelectedRating}
          comment={comment}
          onCommentChange={setComment}
          captureBleDiag={captureBleDiag}
          onCaptureBleDiagChange={setCaptureBleDiag}
          contactConsent={contactConsent}
          onContactConsentChange={setContactConsent}
          attachments={attachments}
          onAttachmentsChange={setAttachments}
          onAttachmentPickingChange={setIsPickingAttachments}
          showDiscordLink={showDiscordLink}
        />
      </ModalSheet>
    </>
  );
});

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[4],
    paddingBottom: spacing[6],
    gap: spacing[4],
  },
});
