import type { ComponentType } from 'react';
import { StyleSheet, View, type TextInputProps } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTypographyStyles, type TypographyScale } from '../../hooks/use-typography-styles';
import { useTheme } from '../../providers/theme-provider';
import { spacing, borderRadius } from '../../theme/tokens';
import type { FeedbackAttachment } from '../../lib/feedback/shared-bug-draft.types';
import { openDiscordInvite } from '../../lib/discord';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Button } from '../Button';
import { PressableSurface } from '../PressableSurface';
import { SwitchRow } from '../SwitchRow';
import { SessionRecordingSwitchRow } from '../settings/SessionRecordingSwitchRow';
import { FeedbackAttachmentPicker } from './FeedbackAttachmentPicker';

export const BUG_COMMENT_MIN_LENGTH = 10;
export const COMMENT_MAX_LENGTH = 2000;
const STAR_RATING_VALUES = [1, 2, 3, 4, 5] as const;

type FeedbackFormProps = {
  mode: 'rating' | 'bug';
  InputComponent: ComponentType<TextInputProps>;
  isAuthenticated: boolean;
  disabled: boolean;
  selectedRating: number | null;
  onRatingChange: (rating: number) => void;
  comment: string;
  onCommentChange: (comment: string) => void;
  captureBleDiag: boolean;
  onCaptureBleDiagChange: (capture: boolean) => void;
  contactConsent: boolean;
  onContactConsentChange: (consent: boolean) => void;
  attachments: FeedbackAttachment[];
  onAttachmentsChange: (attachments: FeedbackAttachment[]) => void | Promise<void>;
  stageAttachment?: (attachment: FeedbackAttachment) => Promise<FeedbackAttachment>;
  onAttachmentPickingChange?: (picking: boolean) => void;
  releaseStagedAttachments?: (attachments: readonly FeedbackAttachment[]) => void;
  showDiscordLink?: boolean;
};

/** Shared report body; the host owns presentation, dismissal, state, and submission. */
export function FeedbackForm({
  mode,
  InputComponent,
  isAuthenticated,
  disabled,
  selectedRating,
  onRatingChange,
  comment,
  onCommentChange,
  captureBleDiag,
  onCaptureBleDiagChange,
  contactConsent,
  onContactConsentChange,
  attachments,
  onAttachmentsChange,
  stageAttachment,
  onAttachmentPickingChange,
  releaseStagedAttachments,
  showDiscordLink = false,
}: FeedbackFormProps) {
  const styles = useTypographyStyles(createStyles);
  const { t } = useTranslation('settings');
  const { systemColors, brandColors } = useTheme();
  const isBugReport = mode === 'bug';
  const remainingBugChars = Math.max(0, BUG_COMMENT_MIN_LENGTH - comment.trim().length);
  const canAttachAttachments = isBugReport && isAuthenticated;
  const inputPlaceholder = isBugReport ? t('feedbackForm.bugPlaceholder') : t('feedbackForm.ratingPlaceholder');
  return (
    <>
      {!isBugReport ? (
        <View style={styles.starRow}>
          {STAR_RATING_VALUES.map((starRating) => {
            const selected = selectedRating !== null && starRating <= selectedRating;
            return (
              <PressableSurface
                key={starRating}
                onPress={() => onRatingChange(starRating)}
                feedback="scale"
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel={t('feedbackForm.starRating', { count: starRating })}
                accessibilityState={{ selected }}
                disabled={disabled}
                style={styles.starButton}
              >
                <Icon name={selected ? 'star.fill' : 'star'} size={34} color={brandColors.warning} />
              </PressableSurface>
            );
          })}
        </View>
      ) : null}

      <InputComponent
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
        onChangeText={onCommentChange}
        multiline
        maxLength={COMMENT_MAX_LENGTH}
        textAlignVertical="top"
        editable={!disabled}
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
            onValueChange={onCaptureBleDiagChange}
            disabled={disabled}
          />
        </View>
      ) : null}

      {canAttachAttachments ? (
        <FeedbackAttachmentPicker
          attachments={attachments}
          onChange={onAttachmentsChange}
          stageAttachment={stageAttachment}
          onPickingChange={onAttachmentPickingChange}
          releaseStagedAttachments={releaseStagedAttachments}
          disabled={disabled}
        />
      ) : null}

      {isBugReport && isAuthenticated ? (
        <View style={[styles.recordingCard, { backgroundColor: systemColors.secondaryBackground }]}>
          <SwitchRow
            label={t('feedbackForm.contactConsentLabel')}
            description={t('feedbackForm.contactConsentDescription')}
            value={contactConsent}
            onValueChange={onContactConsentChange}
            disabled={disabled}
          />
        </View>
      ) : null}

      {showDiscordLink ? (
        <Button
          title={t('feedbackDialog.joinDiscord')}
          onPress={() => {
            void openDiscordInvite('login');
          }}
          variant="text"
          icon="open.external"
          tintColor={brandColors.primary}
        />
      ) : null}
    </>
  );
}

const createStyles = (textStyles: TypographyScale) =>
  StyleSheet.create({
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
      fontSize: textStyles.callout.fontSize,
    },
    helperText: {
      marginTop: -spacing[2],
    },
    recordingCard: {
      overflow: 'hidden',
      borderRadius: borderRadius.lg,
    },
  });
