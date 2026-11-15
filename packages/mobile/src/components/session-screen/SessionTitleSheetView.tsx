import { useTranslation } from 'react-i18next';
import { View, StyleSheet } from 'react-native';
import { SESSION_NAME_MAX_LENGTH } from '@boardsesh/shared-schema';
import { AccessibleBottomSheetTextInput as BottomSheetTextInput } from '../AccessibleBottomSheetTextInput';
import { useTypographyStyles, type TypographyScale } from '../../hooks/use-typography-styles';
import { Sheet } from '../Sheet';
import { Text } from '../Text';
import { SheetTopBar } from '../SheetTopBar';
import { useTheme } from '../../providers/theme-provider';
import { spacing, borderRadius } from '../../theme/tokens';
export type SessionTitleSheetViewProps = {
  visible: boolean;
  name: string;
  isPending: boolean;
  saveDisabled: boolean;
  errorMessage: string | null;
  onChangeName: (name: string) => void;
  onSave: () => void;
  onClose: () => void;
  onPresented?: () => void;
};
export function SessionTitleSheetView({
  visible,
  name,
  isPending,
  saveDisabled,
  errorMessage,
  onChangeName,
  onSave,
  onClose,
  onPresented,
}: SessionTitleSheetViewProps) {
  const styles = useTypographyStyles(createStyles);
  const { t } = useTranslation('session');
  const { t: tCommon } = useTranslation('common');
  const { systemColors, brandColors } = useTheme();
  const header = (
    <SheetTopBar
      title={t('mobile.session.renameTitle')}
      leading={{ kind: 'cancel', onPress: onClose, accessibilityLabel: tCommon('comment.cancel') }}
      trailing={{
        kind: 'confirm',
        label: t('mobile.session.renameSave'),
        onPress: onSave,
        loading: isPending,
        disabled: saveDisabled,
        prominent: true,
      }}
    />
  );

  // The header makes the Sheet wrap its body in a column padded by the keyboard
  // overlap, so the field stays above the keyboard without padding of our own. `androidContentSized`
  // keeps that wrapper content-fitted on Android, where a flex-1 column inside
  // a content-sized host collapses to zero height.
  return (
    <Sheet
      onPresented={onPresented}
      visible={visible}
      enableDynamicSizing
      androidContentSized
      onClose={onClose}
      header={header}
    >
      <View style={styles.body}>
        <BottomSheetTextInput
          value={name}
          onChangeText={onChangeName}
          placeholder={t('creation.form.sessionNamePlaceholder')}
          placeholderTextColor={systemColors.tertiaryLabel}
          maxLength={SESSION_NAME_MAX_LENGTH}
          style={[styles.input, { backgroundColor: systemColors.fill, color: systemColors.label }]}
          returnKeyType="done"
          autoFocus
          onSubmitEditing={onSave}
        />
        {errorMessage !== null ? (
          <Text variant="footnote" color={brandColors.error} style={styles.error}>
            {errorMessage}
          </Text>
        ) : null}
      </View>
    </Sheet>
  );
}

const createStyles = (textStyles: TypographyScale) =>
  StyleSheet.create({
    body: {
      paddingHorizontal: spacing[4],
      paddingTop: spacing[3],
      gap: spacing[3],
    },
    input: {
      borderRadius: borderRadius.lg,
      paddingHorizontal: spacing[3],
      paddingVertical: spacing[3],
      fontSize: textStyles.callout.fontSize,
    },
    error: {
      marginTop: -spacing[1],
    },
  });
