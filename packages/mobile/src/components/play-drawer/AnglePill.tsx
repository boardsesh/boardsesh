import { StyleSheet } from 'react-native';
import { PressableSurface } from '../PressableSurface';
import { Text } from '../Text';
import { drawerActionBarStyles } from '../drawer-action-bar/DrawerActionBar';
import { useTheme } from '../../providers/theme-provider';
import { glassSize } from '../../theme/layout';
import { spacing } from '../../theme/tokens';

type AnglePillProps = {
  angle: number;
  onPress: () => void;
  accessibilityLabel: string;
  /**
   * The MiniPlayer's 44pt slot (#6940): tighter padding so "70°" fits, and the
   * label held at its size so it can't outgrow the slot.
   */
  compact?: boolean;
};

/**
 * The angle as a neutral, label-only outlined capsule (no colour fill), the
 * player's mini inline tier. The player's small row and the MiniPlayer draw the
 * same one.
 */
export function AnglePill({ angle, onPress, accessibilityLabel, compact = false }: AnglePillProps) {
  const { systemColors } = useTheme();
  return (
    <PressableSurface
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      // A label-only mini pill (32pt); hit-slop lifts the tap target back to
      // the 44pt floor without growing the visual chip.
      hitSlop={compact ? 6 : 8}
      style={({ pressed }) => [
        styles.pill,
        compact ? styles.compact : null,
        { borderColor: systemColors.separator },
        pressed && drawerActionBarStyles.actionButtonPressed,
      ]}
    >
      <Text
        variant="caption1"
        color={systemColors.secondaryLabel}
        maxFontSizeMultiplier={compact ? 1 : undefined}
        style={styles.label}
      >
        {angle}°
      </Text>
    </PressableSurface>
  );
}

const styles = StyleSheet.create({
  pill: {
    height: glassSize.mini,
    borderRadius: glassSize.mini / 2,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  compact: {
    paddingHorizontal: spacing[2],
  },
  label: {
    fontWeight: '600',
  },
});
