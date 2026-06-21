import { useEffect, useMemo, useState, type RefObject } from 'react';
import { StyleSheet, View } from 'react-native';
import { BottomSheetModal, BottomSheetTextInput } from '@gorhom/bottom-sheet';
import { useTranslation } from 'react-i18next';
import { ModalSheet } from '../ModalSheet';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Button } from '../Button';
import { PressableSurface } from '../PressableSurface';
import { SessionRecordingSwitchRow } from '../settings/SessionRecordingSwitchRow';
import { useTheme } from '../../providers/theme-provider';
import { useToast } from '../../providers/toast-provider';
import { spacing, borderRadius } from '../../theme/tokens';
import { useSubmitMobileAppFeedback } from '../../lib/feedback/use-submit-app-feedback';
import { openDiscordInvite } from '../../lib/discord';

export type FeedbackSheetMode = 'rating' | 'bug';

const BUG_COMMENT_MIN_LENGTH = 10;
const COMMENT_MAX_LENGTH = 2000;
const STAR_RATING_VALUES = [1, 2, 3, 4, 5] as const;

type FeedbackSheetProps = {
  sheetRef: RefObject<BottomSheetModal | null>;
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
  const { systemColors, brandColors } = useTheme();
  const { showToast } = useToast();
  const { mutateAsync, isPending, reset } = useSubmitMobileAppFeedback();
  const [selectedRating, setSelectedRating] = useState<number | null>(null);
  const [comment, setComment] = useState('');

  const isBugReport = mode === 'bug';
  const trimmedComment = comment.trim();
  const remainingBugChars = Math.max(0, BUG_COMMENT_MIN_LENGTH - trimmedComment.length);
  const canSubmit = isBugReport ? remainingBugChars === 0 : selectedRating !== null;
  const title = isBugReport ? t('feedbackDialog.titleBug') : t('feedbackDialog.titleRating');
  const submitLabel = isBugReport ? t('feedbackDialog.submitBug') : t('feedbackDialog.submitRating');
  const inputPlaceholder = isBugReport ? t('feedbackForm.bugPlaceholder') : t('feedbackForm.ratingPlaceholder');

  useEffect(() => {
    setSelectedRating(null);
    setComment('');
    reset();
  }, [mode, reset]);

  const snapPoints = useMemo(() => (isBugReport ? ['54%', '82%'] : ['44%', '72%']), [isBugReport]);

  const handleDismiss = () => {
    sheetRef.current?.dismiss();
  };

  const handleSubmit = async () => {
    if (!canSubmit || isPending) return;

    try {
      await mutateAsync({
        source: isBugReport ? 'drawer-bug' : 'drawer-feedback',
        rating: isBugReport ? null : selectedRating,
        comment: trimmedComment.length > 0 ? trimmedComment : null,
      });
      sheetRef.current?.dismiss();
      showToast(isBugReport ? t('feedbackDialog.successBug') : t('feedbackDialog.successRating'), 'success');
      setSelectedRating(null);
      setComment('');
    } catch {
      showToast(t('feedbackDialog.errorRating'), 'error');
    }
  };

  return (
    <ModalSheet ref={sheetRef} snapPoints={snapPoints} scrollable contentContainerStyle={styles.content} glass={false}>
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
        </View>
      ) : null}

      <Button
        title={submitLabel}
        onPress={() => {
          void handleSubmit();
        }}
        variant="filled"
        size="large"
        disabled={!canSubmit}
        loading={isPending}
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
