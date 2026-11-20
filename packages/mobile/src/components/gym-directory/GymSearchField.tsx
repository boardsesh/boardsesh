import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { AccessibleTextInput } from '../AccessibleTextInput';
import { ActivityIndicator } from '../ActivityIndicator';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { useTheme } from '../../providers/theme-provider';
import { useTypographyStyles, type TypographyScale } from '../../hooks/use-typography-styles';
import { borderRadius, spacing } from '../../theme/tokens';
import type { GymSearchFieldProps } from './GymSearchField.types';

/** Native keeps the existing submit-to-geocode input; web offers city selection. */
export function GymSearchField({
  text,
  hasSelectedPlace,
  isGeocoding,
  onChangeText,
  onSubmit,
  onClear,
}: GymSearchFieldProps) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  const styles = useTypographyStyles(createStyles);
  return (
    <View style={[styles.field, { backgroundColor: systemColors.background, borderColor: systemColors.separator }]}>
      <Icon name="search" size={18} color={systemColors.secondaryLabel} />
      <AccessibleTextInput
        value={text}
        onChangeText={onChangeText}
        onSubmitEditing={onSubmit}
        placeholder={t('mobile.gyms.searchPlaceholder')}
        accessibilityLabel={t('mobile.gyms.searchPlaceholder')}
        placeholderTextColor={systemColors.tertiaryLabel}
        style={[styles.input, { color: systemColors.label }]}
        autoCorrect={false}
        returnKeyType="search"
      />
      {isGeocoding ? <ActivityIndicator /> : null}
      {text.length > 0 || hasSelectedPlace ? (
        <PressableSurface onPress={onClear} hitSlop={8} accessibilityLabel={t('mobile.gyms.clearSearch')}>
          <Icon name="close" size={18} color={systemColors.secondaryLabel} />
        </PressableSurface>
      ) : null}
    </View>
  );
}

const createStyles = (textStyles: TypographyScale) =>
  StyleSheet.create({
    field: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing[2],
      paddingHorizontal: spacing[3],
      minHeight: 44,
      borderRadius: borderRadius.lg,
      borderWidth: StyleSheet.hairlineWidth,
    },
    input: { flex: 1, fontSize: textStyles.callout.fontSize },
  });
