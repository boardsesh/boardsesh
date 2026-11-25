import { memo, useCallback } from 'react';
import { StyleSheet, View } from 'react-native';
import { AccessibleTextInput } from '../../AccessibleTextInput';
import { Text } from '../../Text';
import { useTheme } from '../../../providers/theme-provider';
import { useTypographyStyles, type TypographyScale } from '../../../hooks/use-typography-styles';
import { borderRadius, spacing } from '../../../theme/tokens';

/**
 * A one-line field on "Add your gym" (the name, the address), drawn like the
 * search field beside it: the same height, corners and hairline edge. `label`
 * is always the field's accessibility label; `showLabel` also prints it above.
 */
export const NewGymTextField = memo(function NewGymTextField({
  label,
  showLabel = false,
  value,
  placeholder,
  maxLength,
  onChangeText,
  onFocusChange,
  autoCapitalize = 'words',
  testID,
}: {
  label: string;
  showLabel?: boolean;
  value: string;
  placeholder: string;
  maxLength: number;
  onChangeText: (text: string) => void;
  onFocusChange?: (focused: boolean) => void;
  autoCapitalize?: 'none' | 'sentences' | 'words';
  testID?: string;
}) {
  const { systemColors } = useTheme();
  const styles = useTypographyStyles(createStyles);
  const handleFocus = useCallback(() => onFocusChange?.(true), [onFocusChange]);
  const handleBlur = useCallback(() => onFocusChange?.(false), [onFocusChange]);
  return (
    <View style={styles.column}>
      {showLabel ? (
        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.label}>
          {label}
        </Text>
      ) : null}
      <View style={[styles.field, { backgroundColor: systemColors.background, borderColor: systemColors.separator }]}>
        <AccessibleTextInput
          value={value}
          onChangeText={onChangeText}
          onFocus={handleFocus}
          onBlur={handleBlur}
          placeholder={placeholder}
          accessibilityLabel={label}
          placeholderTextColor={systemColors.tertiaryLabel}
          maxLength={maxLength}
          autoCapitalize={autoCapitalize}
          autoCorrect={false}
          returnKeyType="done"
          style={[styles.input, { color: systemColors.label }]}
          testID={testID}
        />
      </View>
    </View>
  );
});

const createStyles = (textStyles: TypographyScale) =>
  StyleSheet.create({
    column: { gap: spacing[1] },
    label: { paddingHorizontal: spacing[1] },
    field: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing[3],
      minHeight: 44,
      borderRadius: borderRadius.lg,
      borderWidth: StyleSheet.hairlineWidth,
    },
    input: { flex: 1, fontSize: textStyles.callout.fontSize },
  });
