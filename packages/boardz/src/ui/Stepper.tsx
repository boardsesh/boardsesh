import { Pressable, StyleSheet, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Icon } from './Icon';
import { Minus, Plus } from './icons';
import { Text } from './Text';
import { useTheme } from './theme';
import { radius, spacing } from './tokens';

type StepperProps = {
  /** Spoken name, and the visible label when `showLabel` is on. */
  label: string;
  showLabel?: boolean;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  format?: (value: number) => string;
  /** What VoiceOver says, when the shown value is terse ("2:30" is read as "2 min 30 s"). */
  spokenFormat?: (value: number) => string;
  /** Colour for the value, e.g. a grade's band. */
  valueColor?: string;
  size?: 'md' | 'lg';
};

/** − value +, with the value in light mono. Used for tries, rests, grades. */
export function Stepper({
  label,
  showLabel = false,
  value,
  min,
  max,
  step = 1,
  onChange,
  format = String,
  spokenFormat = format,
  valueColor,
  size = 'md',
}: StepperProps) {
  const theme = useTheme();
  const box = size === 'lg' ? 48 : 44;
  const set = (next: number) => {
    const clamped = Math.min(max, Math.max(min, next));
    if (clamped === value) return;
    void Haptics.selectionAsync();
    onChange(clamped);
  };
  const button = (direction: 1 | -1) => {
    const disabled = direction < 0 ? value <= min : value >= max;
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={direction > 0 ? `More ${label.toLowerCase()}` : `Fewer ${label.toLowerCase()}`}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={() => set(value + direction * step)}
        style={({ pressed }) => [
          styles.button,
          {
            width: box,
            height: box,
            borderColor: theme.border2,
            backgroundColor: pressed ? theme.bgSurface3 : 'transparent',
            opacity: disabled ? 0.35 : 1,
          },
        ]}
      >
        <Icon icon={direction > 0 ? Plus : Minus} size={18} color={theme.fg1} />
      </Pressable>
    );
  };

  return (
    <View style={styles.row}>
      {showLabel ? <Text style={styles.label}>{label}</Text> : null}
      <View
        style={styles.control}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={label}
        accessibilityValue={{ text: spokenFormat(value) }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(event) => set(value + (event.nativeEvent.actionName === 'increment' ? step : -step))}
      >
        {button(-1)}
        <Text
          variant="figure"
          align="center"
          color={valueColor}
          monospacedDigits
          style={[styles.value, size === 'lg' ? styles.valueLarge : styles.valueRegular]}
        >
          {format(value)}
        </Text>
        {button(1)}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md },
  label: { flex: 1 },
  control: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  button: {
    borderWidth: 1,
    borderRadius: radius.md,
    borderCurve: 'continuous',
    alignItems: 'center',
    justifyContent: 'center',
  },
  value: { minWidth: 64 },
  valueRegular: { fontSize: 22, lineHeight: 26, letterSpacing: -0.9 },
  valueLarge: { fontSize: 26, lineHeight: 30, letterSpacing: -1 },
});
