import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from '../../Text';
import { useTheme } from '../../../providers/theme-provider';
import { borderRadius, spacing } from '../../../theme/tokens';

export type Option = {
  key: string;
  label: string;
  /** Why the option can't be picked; set means greyed out and inert. */
  disabledReason?: string;
};

/** A short vertical list of radio rows: one choice, with an optional reason an option is off. */
export function OptionList({
  options,
  selectedKey,
  onSelect,
  label,
}: {
  options: readonly Option[];
  selectedKey: string;
  onSelect: (key: string) => void;
  label: string;
}) {
  const { systemColors } = useTheme();
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      style={[styles.group, { backgroundColor: systemColors.secondaryGroupedBackground }]}
    >
      {options.map((option, index) => {
        const selected = option.key === selectedKey;
        const disabled = option.disabledReason !== undefined;
        return (
          <Pressable
            key={option.key}
            accessibilityRole="radio"
            accessibilityState={{ selected, disabled }}
            disabled={disabled}
            onPress={() => onSelect(option.key)}
            style={[
              styles.row,
              index > 0 && { borderTopColor: systemColors.separator, borderTopWidth: StyleSheet.hairlineWidth },
              disabled && styles.disabled,
            ]}
          >
            <View style={styles.text}>
              <Text variant="body">{option.label}</Text>
              {option.disabledReason ? (
                <Text variant="footnote" tone="secondary">
                  {option.disabledReason}
                </Text>
              ) : null}
            </View>
            {selected ? (
              <Text variant="body" color={systemColors.accent} emphasized>
                ✓
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  group: { borderRadius: borderRadius.lg, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
    gap: spacing[3],
  },
  text: { flex: 1 },
  disabled: { opacity: 0.45 },
});
