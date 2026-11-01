import { StyleSheet } from 'react-native';
import Animated from 'react-native-reanimated';
import type { Climb } from '@boardsesh/queue';
import { PressableSurface } from '../PressableSurface';
import { Icon } from '../Icon';
import { glassSize } from '../../theme/layout';
import { opacity } from '../../theme/tokens';
import { useLogAscentAction } from './use-log-ascent-action';
import type { AccessoryPlacement } from '../../lib/analytics-board-connect';
import { useTheme } from '../../providers/theme-provider';

type LogAscentToolbarButtonProps = {
  climb: Climb;
  queueItemUuid?: string;
  size?: number;
  iconSize?: number;
  /** The accessory platter's placement, when this tick sits on the platter (analytics). */
  placement?: AccessoryPlacement;
  /**
   * `hero`: the iPad MiniPlayer's one large control, a filled circled check in
   * the brand colour, as Music draws its play button. `plain` (the default) is
   * the bare checkmark every other toolbar draws. Both log the same way and pop
   * the same way.
   */
  appearance?: 'plain' | 'hero';
};

/**
 * Borderless toolbar item for the collapsed bottom action toolbar. The enclosing
 * toolbar provides the visible container, so this uses the plain checkmark SF
 * Symbol instead of the circular tick glyph used by standalone FABs.
 */
export function LogAscentToolbarButton({
  climb,
  queueItemUuid,
  size = glassSize.standard,
  iconSize = 26,
  placement,
  appearance = 'plain',
}: LogAscentToolbarButtonProps) {
  const { brandColors } = useTheme();
  const { accessibilityLabel, disabled, handleLogAscentPress, iconColor, popStyle } = useLogAscentAction(
    climb,
    placement,
    queueItemUuid,
  );

  return (
    <Animated.View style={[popStyle, { width: size, height: size }]}>
      <PressableSurface
        onPress={handleLogAscentPress}
        disabled={disabled}
        feedback="opacity"
        hitSlop={4}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ disabled }}
        style={[styles.action, { width: size, height: size }, disabled ? styles.disabled : null]}
      >
        {appearance === 'hero' ? (
          <Icon maxFontSizeMultiplier={1} name="checkmark.circle.fill" size={iconSize} color={brandColors.primary} />
        ) : (
          <Icon maxFontSizeMultiplier={1} name="check.small" size={iconSize} color={iconColor} />
        )}
      </PressableSurface>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  action: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabled: {
    opacity: opacity.disabled,
  },
});
