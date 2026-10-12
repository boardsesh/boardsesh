import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet } from 'react-native';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { usePreventRemove } from 'expo-router/react-navigation';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { FeedbackForm, BUG_COMMENT_MIN_LENGTH } from '../src/components/feedback/FeedbackForm';
import { AccessibleTextInput } from '../src/components/AccessibleTextInput';
import { SheetTopBar } from '../src/components/SheetTopBar';
import { InlineSheetError } from '../src/components/InlineSheetError';
import { Text } from '../src/components/Text';
import { holdUntilLaunchReady } from '../src/components/launch-update/hold-until-launch-ready';
import { FeedbackMetadataCollector, type FeedbackMetadataReader } from '../src/lib/feedback/FeedbackMetadataCollector';
import { uploadFeedbackAttachments } from '../src/lib/feedback/attachment-upload';
import { stageFeedbackAttachment, releaseOwnedFeedbackAttachments } from '../src/lib/feedback/shared-bug-draft';
import { useSubmitMobileAppFeedback } from '../src/lib/feedback/use-submit-app-feedback';
import { readLocalUserId } from '../src/lib/local-user-id';
import { runBleAdvertisementRecon } from '../src/lib/ble/advertisement-recon';
import { useSharedBugDraft, useShareReceipt } from '../src/providers/share-receipt-provider';
import { useAuth } from '../src/providers/auth-provider';
import { useConfirm } from '../src/providers/dialog-provider';
import { useTheme } from '../src/providers/theme-provider';
import { useToast } from '../src/providers/toast-provider';
import { reportError } from '../src/lib/error-reporting';
import { spacing } from '../src/theme/tokens';

function ShareBugScreen() {
  const { draftId } = useLocalSearchParams<{ draftId?: string }>();
  const { draft, updateDraft, clearDraft, finishDraftSubmission } = useSharedBugDraft();
  const { notice, clearNotice } = useShareReceipt();
  const currentDraft = draft?.id === draftId ? draft : null;
  const latestDraft = useRef(currentDraft);
  latestDraft.current = currentDraft;
  const { t } = useTranslation('settings');
  const { t: tCommon } = useTranslation('common');
  const { t: tSession } = useTranslation('session');
  const { systemColors } = useTheme();
  const { isAuthenticated } = useAuth();
  const { showToast } = useToast();
  const confirm = useConfirm();
  const navigation = useNavigation();
  const router = useRouter();
  const metadataReaderRef = useRef<FeedbackMetadataReader | null>(null);
  const { mutateAsync } = useSubmitMobileAppFeedback(metadataReaderRef);
  const [comment, setComment] = useState(currentDraft?.comment ?? '');
  const [contactConsent, setContactConsent] = useState(currentDraft?.contactConsent ?? true);
  const [captureBleDiag, setCaptureBleDiag] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [isPickingAttachments, setIsPickingAttachments] = useState(false);
  const pickingAttachmentsRef = useRef(false);
  const busyRef = useRef(false);
  const promptingRef = useRef(false);
  const allowExitRef = useRef(false);
  const submittedIdsRef = useRef<Set<string> | null>(null);
  const initialDraftIdRef = useRef(currentDraft?.id);

  useEffect(() => {
    if (!currentDraft || initialDraftIdRef.current === currentDraft.id) return;
    initialDraftIdRef.current = currentDraft.id;
    setComment(currentDraft.comment);
    setContactConsent(currentDraft.contactConsent);
    submittedIdsRef.current = null;
    setSubmitError(null);
  }, [currentDraft]);

  useEffect(() => {
    if (!notice) return;
    switch (notice) {
      case 'unsupported':
        setSubmitError(tCommon('feedbackAttachments.unsupported'));
        break;
      case 'overflow':
        setSubmitError(tCommon('feedbackAttachments.tooMany'));
        break;
      case 'tooLarge':
        setSubmitError(tCommon('feedbackAttachments.tooLarge'));
        break;
      case 'failed':
        setSubmitError(tCommon('feedbackAttachments.receiveFailed'));
        break;
      case 'invalidLink':
        setSubmitError(tSession('mobile.betaVideos.urlInvalid'));
        break;
    }
    clearNotice();
  }, [notice, clearNotice, tCommon, tSession]);

  const persist = (updates: Parameters<typeof updateDraft>[1]) => {
    if (!currentDraft) return;
    void updateDraft(currentDraft.id, updates).catch((error: unknown) => {
      reportError(error);
      setSubmitError(tCommon('feedbackAttachments.saveFailed'));
    });
  };
  const dismiss = () => {
    allowExitRef.current = true;
    if (router.canDismiss()) router.dismiss();
    else router.replace('/');
  };
  const requestDiscard = async (afterDiscard: () => void) => {
    if (busyRef.current || pickingAttachmentsRef.current || promptingRef.current) return;
    const requestedId = currentDraft?.id;
    if (!requestedId) {
      allowExitRef.current = true;
      afterDiscard();
      return;
    }
    promptingRef.current = true;
    try {
      const discard = await confirm({
        title: tCommon('unsavedChanges.title'),
        message: tCommon('unsavedChanges.message'),
        confirmLabel: tCommon('unsavedChanges.discard'),
        cancelLabel: tCommon('unsavedChanges.keepEditing'),
        destructive: true,
      });
      if (!discard || busyRef.current || pickingAttachmentsRef.current || latestDraft.current?.id !== requestedId)
        return;
      await clearDraft(requestedId);
      allowExitRef.current = true;
      afterDiscard();
    } catch (error) {
      reportError(error);
      setSubmitError(tCommon('feedbackAttachments.saveFailed'));
    } finally {
      promptingRef.current = false;
    }
  };
  usePreventRemove(true, ({ data: { action } }) => {
    if (allowExitRef.current) navigation.dispatch(action);
    else void requestDiscard(() => navigation.dispatch(action));
  });

  const finishSubmittedDraft = async (submittedDraftId: string) => {
    // This runs inside the receipt queue so a pending native share cannot be
    // appended between the read and removal of the submitted files.
    const cleared = await finishDraftSubmission(submittedDraftId, [...(submittedIdsRef.current ?? [])]);
    if (cleared) {
      dismiss();
      showToast(t('feedbackDialog.successBug'), 'success');
      return;
    }
    setComment('');
    setContactConsent(true);
    setCaptureBleDiag(false);
    submittedIdsRef.current = null;
    setSuccessMessage(t('feedbackDialog.successBug'));
  };

  const handleSubmit = async () => {
    if (
      !currentDraft ||
      !isAuthenticated ||
      busyRef.current ||
      pickingAttachmentsRef.current ||
      comment.trim().length < BUG_COMMENT_MIN_LENGTH
    )
      return;
    const submittingDraft = currentDraft;
    busyRef.current = true;
    setBusy(true);
    setSubmitError(null);
    setSuccessMessage(null);
    try {
      // If filing succeeded but local cleanup failed, retry cleanup alone.
      if (!submittedIdsRef.current) {
        const accountId = await readLocalUserId();
        if (!accountId) throw new Error('Sign in before attaching media');
        let uploadedKeys =
          submittingDraft.uploadedKeysAccountId === accountId ? { ...submittingDraft.uploadedKeysByUri } : {};
        await updateDraft(submittingDraft.id, { uploadedKeysAccountId: accountId, uploadedKeysByUri: uploadedKeys });
        let attachmentKeys: Awaited<ReturnType<typeof uploadFeedbackAttachments>>;
        try {
          attachmentKeys = await uploadFeedbackAttachments(
            submittingDraft.attachments,
            uploadedKeys,
            async (uri, key) => {
              if ((await readLocalUserId()) !== accountId) throw new Error('Account changed during upload');
              uploadedKeys = { ...uploadedKeys, [uri]: key };
              await updateDraft(submittingDraft.id, {
                uploadedKeysAccountId: accountId,
                uploadedKeysByUri: uploadedKeys,
              });
            },
          );
        } catch (error) {
          reportError(error);
          setSubmitError(tCommon('feedbackAttachments.uploadFailed'));
          return;
        }
        if ((await readLocalUserId()) !== accountId) throw new Error('Account changed during submission');
        if (captureBleDiag) {
          void runBleAdvertisementRecon(`bug-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`).catch(() => {});
        }
        const submitted = await mutateAsync({
          source: 'share-bug',
          rating: null,
          comment: comment.trim(),
          contactConsent,
          screenshotKeys: attachmentKeys.screenshotKeys.length > 0 ? attachmentKeys.screenshotKeys : null,
          recordingKeys: attachmentKeys.recordingKeys.length > 0 ? attachmentKeys.recordingKeys : null,
        });
        if (!submitted) throw new Error('Report submission failed');
        submittedIdsRef.current = new Set(submittingDraft.attachments.map((attachment) => attachment.id));
      }
      await finishSubmittedDraft(submittingDraft.id);
    } catch (error) {
      reportError(error);
      setSubmitError(
        submittedIdsRef.current ? tCommon('feedbackAttachments.cleanupFailed') : t('feedbackDialog.errorRating'),
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <SafeAreaView edges={['top', 'bottom']} style={[styles.screen, { backgroundColor: systemColors.background }]}>
      <FeedbackMetadataCollector readerRef={metadataReaderRef} />
      <SheetTopBar
        title={t('feedbackDialog.titleBug')}
        leading={{
          kind: 'cancel',
          onPress: () => {
            void requestDiscard(dismiss);
          },
          disabled: busy || isPickingAttachments,
        }}
        trailing={{
          kind: 'send',
          label: t('feedbackDialog.submitBug'),
          onPress: () => {
            void handleSubmit();
          },
          disabled:
            !currentDraft ||
            !isAuthenticated ||
            busy ||
            isPickingAttachments ||
            comment.trim().length < BUG_COMMENT_MIN_LENGTH,
          loading: busy,
          prominent: true,
        }}
      />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.screen}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          <InlineSheetError
            message={submitError ?? (!currentDraft ? tCommon('feedbackAttachments.missingDraft') : null)}
            visible
            scope="share-bug"
          />
          {successMessage ? (
            <Text variant="footnote" accessibilityRole="text" accessibilityLiveRegion="polite">
              {successMessage}
            </Text>
          ) : null}
          {currentDraft ? (
            <FeedbackForm
              mode="bug"
              InputComponent={AccessibleTextInput}
              isAuthenticated={isAuthenticated}
              disabled={busy || submittedIdsRef.current !== null}
              selectedRating={null}
              onRatingChange={() => {}}
              comment={comment}
              onCommentChange={(nextComment) => {
                setComment(nextComment);
                persist({ comment: nextComment });
              }}
              captureBleDiag={captureBleDiag}
              onCaptureBleDiagChange={setCaptureBleDiag}
              contactConsent={contactConsent}
              onContactConsentChange={(consent) => {
                setContactConsent(consent);
                persist({ contactConsent: consent });
              }}
              attachments={currentDraft.attachments}
              stageAttachment={stageFeedbackAttachment}
              onAttachmentPickingChange={(picking) => {
                pickingAttachmentsRef.current = picking;
                setIsPickingAttachments(picking);
              }}
              releaseStagedAttachments={releaseOwnedFeedbackAttachments}
              onAttachmentsChange={(attachments) =>
                updateDraft(currentDraft.id, {
                  attachments,
                  attachmentBaselineIds: currentDraft.attachments.map((attachment) => attachment.id),
                })
              }
            />
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export default holdUntilLaunchReady(ShareBugScreen);

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { paddingHorizontal: spacing[4], paddingTop: spacing[4], paddingBottom: spacing[6], gap: spacing[4] },
});
