// The toolbar's standalone right-hand log-ascent FAB. The bottom-bar Climbs
// screen uses `LogAscentToolbarButton` instead so the tick can sit inside a
// single HIG-style action toolbar with search.

import Animated from 'react-native-reanimated';
import type { Climb } from '@boardsesh/queue';
import { GlassIconButton } from '../GlassIconButton';
import { glassSize } from '../../theme/layout';
import { useLogAscentAction } from './use-log-ascent-action';

type LogAscentFabProps = {
  climb: Climb;
  size?: number;
};

export function LogAscentFab({ climb, size = glassSize.hero }: LogAscentFabProps) {
  const { accessibilityLabel, disabled, fallbackColor, handleLogAscentPress, iconColor, popStyle } =
    useLogAscentAction(climb);

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
