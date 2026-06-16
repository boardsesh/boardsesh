import { StyleSheet, View } from 'react-native';
import { Text } from './Text';
import { Icon } from './Icon';
import { PressableSurface } from './PressableSurface';
import { useTheme } from '../providers/theme-provider';
import { useVariantValue } from '../theme/variants';
import { spacing, borderRadius } from '../theme/tokens';

type StepperProps = {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (nextValue: number) => void;
  decreaseLabel: string;
  increaseLabel: string;
};

function clampStepperValue(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * A grouped-list stepper row: label on the left, value + −/+ controls trailing.
 * Designed to sit inside an iOS grouped inset card (one per row, hairline
 * divided by the parent). Clamps to [min, max] before reporting changes.
 */
export function Stepper({ label, value, min, max, onChange, decreaseLabel, increaseLabel }: StepperProps) {
  const { systemColors, brandColors, opacity: themeOpacity, m3 } = useTheme();
  const isMaterial = useVariantValue({ material: true, liquidGlass: false });
  const decrementDisabled = value <= min;
  const incrementDisabled = value >= max;

  const updateValue = (nextValue: number) => onChange(clampStepperValue(nextValue, min, max));

  // Material: a tonal secondary-container pill with onSecondaryContainer glyphs
  // and a state-layer ripple (Android), 48dp targets. Glass keeps the iOS
  // tertiaryBackground fill + violet glyphs + scale feedback.
  const controlsFill = isMaterial ? m3.secondaryContainer : systemColors.tertiaryBackground;
  const dividerColor = isMaterial ? m3.outlineVariant : systemColors.separator;
  const activeGlyph = isMaterial ? m3.onSecondaryContainer : brandColors.primary;
  const buttonStyle = [styles.button, isMaterial && styles.buttonMaterial];

  return (
    <View style={[styles.row, isMaterial && styles.rowMaterial]}>
      <Text variant="body" style={styles.label}>
        {label}
      </Text>
      <View style={styles.trailing}>
        <Text variant="body" color={systemColors.label} style={styles.value}>
          {value}
        </Text>
        <View style={[styles.controls, { backgroundColor: controlsFill }]}>
          <PressableSurface
            onPress={() => updateValue(value - 1)}
            disabled={decrementDisabled}
            feedback="scale"
            rippleColor={isMaterial ? m3.onSecondaryContainer : undefined}
            hitSlop={2}
            accessibilityRole="button"
            accessibilityLabel={decreaseLabel}
            style={[buttonStyle, decrementDisabled ? { opacity: themeOpacity.disabled } : null]}
          >
            <Icon name="minus" size={16} color={decrementDisabled ? systemColors.tertiaryLabel : activeGlyph} />
          </PressableSurface>
          <View style={[styles.controlDivider, { backgroundColor: dividerColor }]} />
          <PressableSurface
            onPress={() => updateValue(value + 1)}
            disabled={incrementDisabled}
            feedback="scale"
            rippleColor={isMaterial ? m3.onSecondaryContainer : undefined}
            hitSlop={2}
            accessibilityRole="button"
            accessibilityLabel={increaseLabel}
            style={[buttonStyle, incrementDisabled ? { opacity: themeOpacity.disabled } : null]}
          >
            <Icon name="plus" size={16} color={incrementDisabled ? systemColors.tertiaryLabel : activeGlyph} />
          </PressableSurface>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
    minHeight: 44,
    gap: spacing[3],
  },
  // M3 lifts the row to a 48dp minimum so the taller ± targets sit comfortably.
  rowMaterial: {
    minHeight: 48,
  },
  label: {
    flex: 1,
    minWidth: 0,
  },
  trailing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
  },
  value: {
    minWidth: 28,
    textAlign: 'right',
    fontWeight: '600',
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: borderRadius.md,
    overflow: 'hidden',
  },
  controlDivider: {
    width: StyleSheet.hairlineWidth,
    alignSelf: 'stretch',
  },
  button: {
    width: 44,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // M3 ≥48dp touch target for the ± controls.
  buttonMaterial: {
    width: 48,
    height: 48,
  },
});
