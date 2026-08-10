import Animated, { useAnimatedStyle, useDerivedValue, withTiming } from 'react-native-reanimated';
import { Icon } from './Icon';
import { iosSystemColors } from '../theme/ios-colors';
import { timing } from '../theme/animations';

type SectionDisclosureChevronProps = {
  expanded: boolean;
  size?: number;
};

/**
 * The rotating disclosure chevron shared by collapsible section headers —
 * extracted from `CollapsibleSection` so headers that can't adopt that
 * component (the beta shelves, whose card chrome and content padding would
 * break their edge-to-edge horizontal scrollers) still animate identically.
 *
 * Driven by `useDerivedValue` off the `expanded` prop rather than a shared value
 * the caller mutates, so a header can stay stateless and let the persisted store
 * be the single source of truth.
 */
export function SectionDisclosureChevron({ expanded, size = 16 }: SectionDisclosureChevronProps) {
  const rotation = useDerivedValue(() => withTiming(expanded ? 1 : 0, { duration: timing.normal }), [expanded]);

  const style = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value * 180}deg` }],
  }));

  return (
    <Animated.View style={style}>
      <Icon name="chevron.down" size={size} color={iosSystemColors.systemGray} />
    </Animated.View>
  );
}
