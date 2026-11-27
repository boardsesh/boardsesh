// The toolbar's standalone right-hand log-ascent FAB. The bottom-bar Climbs
// screen uses `LogAscentToolbarButton` instead so the tick can sit inside a
// single HIG-style action toolbar with search.

import Animated from 'react-native-reanimated';
import type { Climb } from '@boardsesh/queue';
import type { BoardConfig } from '../../providers/drawer-host-provider';
import { GlassIconButton } from '../GlassIconButton';
import { glassSize } from '../../theme/layout';
import { useLogAscentAction } from './use-log-ascent-action';

type LogAscentFabProps = {
  climb: Climb;
  boardConfigOverride?: BoardConfig;
  size?: number;
  /** The flip to log, when the bar shows the climber's last pick: the pick's own (`useLogAscentAction`). */
  isMirror?: boolean;
};

export function LogAscentFab({ climb, size = glassSize.hero, isMirror, boardConfigOverride }: LogAscentFabProps) {
  const { accessibilityLabel, disabled, fallbackColor, handleLogAscentPress, iconColor, popStyle } = useLogAscentAction(
    climb,
    undefined,
    undefined,
    isMirror,
    boardConfigOverride,
  );

  return (
    <Animated.View style={popStyle}>
      <GlassIconButton
        iconName="tick"
        iconColor={iconColor}
        iconSize={26}
        onPress={handleLogAscentPress}
        disabled={disabled}
        accessibilityLabel={accessibilityLabel}
        fallbackColor={fallbackColor}
        size={size}
      />
    </Animated.View>
  );
}
