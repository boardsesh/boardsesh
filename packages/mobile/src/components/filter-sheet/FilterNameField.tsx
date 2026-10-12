import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { AccessibleTextInput as TextInput } from '../AccessibleTextInput';
import { PressableSurface } from '../PressableSurface';
import { Icon } from '../Icon';
import { useTheme } from '../../providers/theme-provider';
import { useTypographyStyles, type TypographyScale } from '../../hooks/use-typography-styles';
import { spacing } from '../../theme/tokens';

// The clear glyph is 14pt; this slop takes its target to 44pt tall inside the
// 44pt field. It reaches less far towards the text, so a tap at the end of the
// typed name places the cursor instead of clearing it.
const CLEAR_HIT_SLOP = { top: 15, bottom: 15, left: 8, right: 15 } as const;

export type FilterNameFieldProps = {
  /** The field's text; the caller keeps it, so it stays live per keystroke. */
  value: string;
  onChangeText: (text: string) => void;
  /** The trailing × (shown only while there is text). */
  onClear: () => void;
  placeholder: string;
  /** Usually the section's title, e.g. "Climb name". */
  accessibilityLabel: string;
};

/**
 * A filter sheet's free-text search row: a filled pill in the same language as
 * the tappable rows, with an inline clear button once there is text.
 */
export const FilterNameField = memo(function FilterNameField({
  value,
  onChangeText,
  onClear,
  placeholder,
  accessibilityLabel,
}: FilterNameFieldProps) {
  const styles = useTypographyStyles(createStyles);
  const { t } = useTranslation('common');
  const { systemColors } = useTheme();
  return (
    <View style={[styles.row, { backgroundColor: systemColors.tertiaryBackground }]}>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={systemColors.tertiaryLabel}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        accessibilityLabel={accessibilityLabel}
        style={[styles.input, { color: systemColors.label }]}
      />
      {value.length > 0 ? (
        <PressableSurface
          onPress={onClear}
          hitSlop={CLEAR_HIT_SLOP}
          accessibilityRole="button"
          accessibilityLabel={t('actions.clear')}
        >
          <Icon name="close" size={14} color={systemColors.tertiaryLabel} />
        </PressableSurface>
      ) : null}
    </View>
  );
});

const createStyles = (textStyles: TypographyScale) =>
  StyleSheet.create({
    // Same tertiaryBackground pill language as the tappable rows, so the field
    // reads as part of the family.
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing[2],
      paddingHorizontal: spacing[4],
      paddingVertical: spacing[3],
      borderRadius: 10,
      minHeight: 44,
    },
    input: {
      flex: 1,
      fontSize: textStyles.body.fontSize,
      paddingVertical: 0,
    },
  });
