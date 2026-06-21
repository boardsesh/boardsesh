import { Pressable, View, StyleSheet } from 'react-native';
import { Text } from './Text';
import { Icon } from './Icon';
import { hapticSelection } from '../lib/haptics';
import { useTheme } from '../providers/theme-provider';
import { iosSystemColors } from '../theme/ios-colors';
import { spacing } from '../theme/tokens';

export type RadioOption<T extends string> = {
  value: T;
  label: string;
  description?: string;
  disabled?: boolean;
};

type RadioGroupProps<T extends string> = {
  options: ReadonlyArray<RadioOption<T>>;
  value: T;
  onChange: (value: T) => void;
};

export function RadioGroup<T extends string>({ options, value, onChange }: RadioGroupProps<T>) {
  const { systemColors, brandColors } = useTheme();
  return (
    <View style={[styles.container, { backgroundColor: systemColors.secondaryBackground }]}>
      {options.map((option, index) => {
        const selected = option.value === value;
        const isLast = index === options.length - 1;
        return (
          <Pressable
            key={option.value}
            onPress={() => {
              if (option.disabled) return;
              hapticSelection();
              onChange(option.value);
            }}
            disabled={option.disabled}
            accessibilityRole="radio"
            accessibilityState={{ selected, disabled: option.disabled }}
            accessibilityLabel={option.label}
            style={({ pressed }) => [
              styles.row,
              !isLast && styles.rowBorder,
              pressed && !option.disabled && styles.rowPressed,
            ]}
          >
            <View style={styles.textColumn}>
              <Text variant="body" style={option.disabled ? styles.textDisabled : undefined}>
                {option.label}
              </Text>
              {option.description ? (
                <Text variant="footnote" style={[styles.description, option.disabled && styles.textDisabled]}>
                  {option.description}
                </Text>
              ) : null}
            </View>
            {selected ? <Icon name="check.small" size={18} color={brandColors.primary} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: 10,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    minHeight: 44,
  },
  rowBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: iosSystemColors.separator,
  },
  rowPressed: {
    opacity: 0.6,
  },
  textColumn: {
    flex: 1,
    gap: 2,
  },
  description: {
    opacity: 0.55,
  },
  textDisabled: {
    opacity: 0.4,
  },
});
