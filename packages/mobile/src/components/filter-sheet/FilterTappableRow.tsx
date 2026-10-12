import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { PressableSurface } from '../PressableSurface';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { useTheme } from '../../providers/theme-provider';
import { opacity, spacing } from '../../theme/tokens';

export type FilterTappableRowProps = {
  label: string;
  /** The current choice, e.g. "None" or "3 setters". Read out as the row's value. */
  value: string;
  /** Usually pushes a picker route (see `useSheetSubRoute`). */
  onPress: () => void;
  disabled?: boolean;
  /** Defaults to `label`. */
  accessibilityLabel?: string;
};

/**
 * A filter sheet row that opens a picker: the label, the current choice and a
 * chevron, on the same filled pill as the name field.
 */
export const FilterTappableRow = memo(function FilterTappableRow({
  label,
  value,
  onPress,
  disabled = false,
  accessibilityLabel,
}: FilterTappableRowProps) {
  const { systemColors } = useTheme();
  return (
    <PressableSurface
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityValue={{ text: value }}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: systemColors.tertiaryBackground },
        pressed && styles.rowPressed,
        disabled && styles.rowDisabled,
      ]}
    >
      <Text variant="body">{label}</Text>
      <View style={styles.trailing}>
        <Text variant="footnote" style={styles.value}>
          {value}
        </Text>
        <Icon name="chevron.right" size={14} color={systemColors.tertiaryLabel} />
      </View>
    </PressableSurface>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    borderRadius: 10,
    minHeight: 44,
  },
  rowPressed: {
    opacity: 0.6,
  },
  rowDisabled: {
    opacity: opacity.disabled,
  },
  trailing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  value: {
    opacity: 0.55,
  },
});
