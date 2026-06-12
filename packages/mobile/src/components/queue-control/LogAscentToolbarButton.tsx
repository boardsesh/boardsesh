import { StyleSheet } from 'react-native';
import Animated from 'react-native-reanimated';
import type { Climb } from '@boardsesh/queue';
import { PressableSurface } from '../PressableSurface';
import { Icon } from '../Icon';
import { glassSize } from '../../theme/layout';
import { opacity } from '../../theme/tokens';
import { useLogAscentAction } from './use-log-ascent-action';

type LogAscentToolbarButtonProps = {
  climb: Climb;
  size?: number;
  iconSize?: number;
};

/**
 * Borderless toolbar item for the collapsed bottom action toolbar. The enclosing
 * toolbar provides the visible container, so this uses the plain checkmark SF
 * Symbol instead of the circular tick glyph used by standalone FABs.
 */
export function LogAscentToolbarButton({
  climb,
  size = glassSize.standard,
  iconSize = 26,
}: LogAscentToolbarButtonProps) {
  const { accessibilityLabel, disabled, handleLogAscentPress, iconColor, popStyle } = useLogAscentAction(climb);

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
        <Icon name="check.small" size={iconSize} color={iconColor} />
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
