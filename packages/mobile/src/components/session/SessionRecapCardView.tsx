import { SESSION_NOTES_MAX_LENGTH } from '@boardsesh/shared-schema';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { useTypographyStyles, type TypographyScale } from '../../hooks/use-typography-styles';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';
import { AccessibleTextInput as TextInput } from '../AccessibleTextInput';
import { Button } from '../Button';
import { Card } from '../Card';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { Text } from '../Text';

export type SessionRecapCardViewProps = {
  displayedNotes?: string | null;
  editable: boolean;
  isEditing: boolean;
  draft: string;
  pending: boolean;
  error: boolean;
  onChangeDraft: (draft: string) => void;
  onEdit: () => void;
  onCancel: () => void;
  onSave: () => void;
  onEditorFocus?: () => void;
};
export function SessionRecapCardView({
  displayedNotes,
  editable,
  isEditing,
  draft,
  pending,
  error,
  onChangeDraft,
  onEdit,
  onCancel,
  onSave,
  onEditorFocus,
}: SessionRecapCardViewProps) {
  const styles = useTypographyStyles(createStyles);
  const { t } = useTranslation('session');
  const { t: tCommon } = useTranslation('common');
  const { systemColors, brandColors } = useTheme();
  const hasNotes = !!displayedNotes && displayedNotes.trim().length > 0;
  if (isEditing) {
    return (
      <Card style={styles.card}>
        <Text variant="caption1" color={systemColors.secondaryLabel}>
          {t('summary.commentLabel')}
        </Text>
        <TextInput
          style={[styles.input, { backgroundColor: systemColors.fill, color: systemColors.label }]}
          placeholder={t('summary.commentPlaceholder')}
          placeholderTextColor={systemColors.tertiaryLabel}
          accessibilityLabel={t('summary.commentLabel')}
          value={draft}
          onChangeText={onChangeDraft}
          maxLength={SESSION_NOTES_MAX_LENGTH}
          multiline
          autoFocus
          textAlignVertical="top"
          onFocus={onEditorFocus}
        />
        <Text variant="caption2" color={systemColors.secondaryLabel} style={styles.helper}>
          {t('summary.commentHelper', { count: draft.length, max: SESSION_NOTES_MAX_LENGTH })}
        </Text>
        {error ? (
          <Text variant="footnote" color={brandColors.error}>
            {t('summary.recapSaveError')}
          </Text>
        ) : null}
        <View style={styles.actions}>
          <Button title={tCommon('comment.cancel')} variant="text" onPress={onCancel} />
          <Button title={tCommon('comment.save')} variant="filled" loading={pending} onPress={onSave} />
        </View>
      </Card>
    );
  }

  // Read mode with a recap: the creator can tap to edit; viewers see it read-only.
  if (hasNotes) {
    return (
      <Card
        style={styles.card}
        onPress={editable ? onEdit : undefined}
        accessibilityLabel={editable ? `${t('summary.recapTitle')}: ${displayedNotes}` : undefined}
      >
        <View style={styles.captionRow}>
          <Text variant="caption1" color={systemColors.secondaryLabel}>
            {t('summary.recapTitle')}
          </Text>
          {editable ? <Icon name="edit" size={14} color={systemColors.secondaryLabel} /> : null}
        </View>
        <Text variant="body">{displayedNotes}</Text>
      </Card>
    );
  }

  // Empty + editable: an add-a-recap affordance that opens the inline editor.
  if (editable) {
    return (
      <PressableSurface
        style={[styles.addRow, { backgroundColor: systemColors.secondaryBackground }]}
        feedback="opacity"
        onPress={onEdit}
        accessibilityRole="button"
        accessibilityLabel={t('summary.addRecap')}
      >
        <Icon name="plus" size={20} color={systemColors.accent} />
        <Text variant="body" color={systemColors.accent} style={styles.addLabel}>
          {t('summary.addRecap')}
        </Text>
        <Icon name="chevron.right" size={14} color={systemColors.tertiaryLabel} />
      </PressableSurface>
    );
  }

  return null;
}

const createStyles = (textStyles: TypographyScale) =>
  StyleSheet.create({
    card: {
      gap: spacing[1],
    },
    input: {
      minHeight: 88,
      maxHeight: 160,
      borderRadius: borderRadius.lg,
      paddingHorizontal: spacing[3],
      paddingVertical: spacing[2],
      fontSize: textStyles.subheadline.fontSize,
      marginTop: spacing[1],
    },
    helper: {
      textAlign: 'right',
    },
    actions: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      alignItems: 'center',
      gap: spacing[2],
      marginTop: spacing[1],
    },
    addRow: {
      flexDirection: 'row',
      alignItems: 'center',
      minHeight: 44,
      paddingHorizontal: spacing[4],
      paddingVertical: spacing[3],
      gap: spacing[3],
      borderRadius: borderRadius.lg,
      overflow: 'hidden',
    },
    addLabel: {
      flex: 1,
    },
    captionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing[1],
    },
  });
