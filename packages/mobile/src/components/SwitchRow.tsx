import { Pressable, Switch as RNSwitch, View, StyleSheet } from 'react-native';
import { Switch as PaperSwitch } from 'react-native-paper';
import { Text } from './Text';
import { hapticSelection } from '../lib/haptics';
import { iosSystemColors } from '../theme/ios-colors';
import { spacing } from '../theme/tokens';
import { useTheme } from '../providers/theme-provider';
import { selectByVariant } from '../theme/variants';

type SwitchRowProps = {
  label: string;
  description?: string;
  value: boolean;
  onValueChange: (next: boolean) => void;
  disabled?: boolean;
};

export function SwitchRow({ label, description, value, onValueChange, disabled = false }: SwitchRowProps) {
  const { variant: uiVariant, brandColors } = useTheme();

  const handleToggle = (next: boolean) => {
    if (disabled) return;
    hapticSelection();
    onValueChange(next);
  };

  return (
    <Pressable
      onPress={() => handleToggle(!value)}
      disabled={disabled}
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled }}
      accessibilityLabel={label}
      style={({ pressed }) => [styles.row, pressed && !disabled && styles.rowPressed]}
    >
      <View style={styles.textColumn}>
        <Text variant="body" style={disabled ? styles.textDisabled : undefined}>
          {label}
        </Text>
        {description ? (
          <Text variant="footnote" style={[styles.description, disabled && styles.textDisabled]}>
            {description}
          </Text>
        ) : null}
      </View>
      {selectByVariant(uiVariant, {
        // The outer Pressable owns the toggle for the whole row. Paper's Switch is
        // a non-interactive visual indicator here (pointerEvents none, no
        // onValueChange) so a tap on the switch passes through to the row instead
        // of double-firing the toggle (Paper's Switch wraps its own Pressable,
        // which doesn't reliably absorb the touch the way the native RN Switch
        // does on the Liquid Glass path). It picks up M3 colours from PaperProvider.
        material: (
          <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <PaperSwitch value={value} disabled={disabled} />
          </View>
        ),
        liquidGlass: (
          <RNSwitch
            value={value}
            onValueChange={handleToggle}
            disabled={disabled}
            // Filled track behind a white thumb — use the scheme-aware brand FILL so
            // dark mode gets the brighter #7C3AED (white thumb 5.70:1). The lighter
            // track also reduces the contrast of iOS's native track-edge highlight,
            // which is what reads as a "white rim" on a dark, saturated switch.
            trackColor={{ false: undefined, true: brandColors.primaryFill }}
            ios_backgroundColor={iosSystemColors.systemGray4 as string}
          />
        ),
      })}
    </Pressable>
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
