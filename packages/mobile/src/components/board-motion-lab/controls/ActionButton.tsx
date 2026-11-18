import { Pressable, StyleSheet } from 'react-native';
import { Text } from '../../Text';
import { useTheme } from '../../../providers/theme-provider';
import { borderRadius, spacing } from '../../../theme/tokens';

export function ActionButton({
  label,
  onPress,
  disabled = false,
  prominent = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  prominent?: boolean;
}) {
  const { systemColors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.button,
        { backgroundColor: prominent ? systemColors.accent : systemColors.secondaryGroupedBackground },
        disabled && styles.disabled,
      ]}
    >
      <Text variant="headline" color={prominent ? '#FFFFFF' : systemColors.accent}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    flex: 1,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: borderRadius.lg,
    paddingHorizontal: spacing[3],
  },
  disabled: { opacity: 0.45 },
});
