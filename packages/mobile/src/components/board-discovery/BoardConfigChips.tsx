import { memo } from 'react';
import { ScrollView, Pressable, StyleSheet } from 'react-native';
import { useTheme } from '../../providers/theme-provider';
import { spacing, borderRadius } from '../../theme/tokens';
import { brandColors } from '../../theme/colors';
import { iosSystemColors } from '../../theme/ios-colors';
import { Text } from '../Text';

export type ChipOption<T> = {
  key: string | number;
  label: string;
  value: T;
  selected: boolean;
};

type BoardConfigChipsProps<T> = {
  /** Spoken group context, e.g. "Layout" — prefixes each chip's a11y label. */
  groupLabel: string;
  options: ChipOption<T>[];
  onSelect: (value: T) => void;
  /** Read-only: chips render dimmed and ignore taps (e.g. locked config on edit). */
  disabled?: boolean;
};

/**
 * A horizontal row of selectable chips for one board-config dimension (board
 * type / layout / size / angle / sets). Carries selection to assistive tech via
 * `accessibilityState.selected` (not colour alone), and `hitSlop` keeps the
 * touch target ≥44pt even though the chip is visually compact.
 */
function BoardConfigChipsInner<T>({ groupLabel, options, onSelect, disabled = false }: BoardConfigChipsProps<T>) {
  const { systemColors, brandColors: themeBrandColors } = useTheme();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
      {options.map((option) => (
        <Pressable
          key={option.key}
          onPress={disabled ? undefined : () => onSelect(option.value)}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityState={{ selected: option.selected, disabled }}
          accessibilityLabel={`${groupLabel}: ${option.label}`}
          hitSlop={8}
          style={[
            styles.chip,
            disabled && styles.chipDisabled,
            {
              // Border is a foreground accent → scheme-aware. Fill stays static:
              // the selected label turns white and must sit on the brand fill.
              borderColor: option.selected ? themeBrandColors.primary : systemColors.separator,
              backgroundColor: option.selected ? brandColors.primary : 'transparent',
            },
          ]}
        >
          <Text variant="footnote" color={option.selected ? iosSystemColors.white : systemColors.label}>
            {option.label}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

// memo so a re-render of the builder screen (e.g. each angle-slider snap) skips
// chip rows whose options/onSelect are unchanged. The cast preserves the generic
// call signature that React.memo would otherwise erase.
export const BoardConfigChips = memo(BoardConfigChipsInner) as typeof BoardConfigChipsInner;

const styles = StyleSheet.create({
  row: {
    gap: spacing[2],
    paddingVertical: spacing[1],
  },
  chip: {
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    borderRadius: borderRadius.full,
    borderWidth: StyleSheet.hairlineWidth,
  },
  chipDisabled: {
    opacity: 0.4,
  },
});
