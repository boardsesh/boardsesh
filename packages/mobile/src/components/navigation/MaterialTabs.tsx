import { useCallback, useState } from 'react';
import { type LayoutChangeEvent, StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, withTiming } from 'react-native-reanimated';
import { Text } from '../Text';
import { PressableSurface } from '../PressableSurface';
import { hapticSelection } from '../../lib/haptics';
import { spacing } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';

// M3 primary-tab active-indicator: a 3dp underline sitting flush under the
// active label. The container measures its own width via onLayout, so the
// indicator width / offset are derived from equal-width tab slots.
const INDICATOR_HEIGHT = 3;

type MaterialTabOption<K extends string> = {
  key: K;
  label: string;
};

type MaterialTabsProps<K extends string> = {
  options: MaterialTabOption<K>[];
  selectedKey: K;
  onSelect: (key: K) => void;
  /** Accessibility label naming the group (announced when VoiceOver/TalkBack
   *  enters the tab row). */
  accessibilityLabel?: string;
};

function MaterialTab({
  label,
  selected,
  onPress,
  rippleColor,
  activeColor,
  inactiveColor,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  rippleColor: string;
  activeColor: string;
  inactiveColor: string;
}) {
  return (
    <PressableSurface
      onPress={onPress}
      feedback="none"
      rippleColor={rippleColor}
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      style={styles.tab}
    >
      <Text variant="subheadline" color={selected ? activeColor : inactiveColor} style={styles.label}>
        {label}
      </Text>
    </PressableSurface>
  );
}

/**
 * Material 3 primary tabs — a horizontal equal-width row of text labels with a
 * sliding active-indicator underline. The flat M3 counterpart of the Liquid
 * Glass `SegmentedControl`, sharing its generic prop API so call sites read the
 * same. Each tab is an equal-width slot, so the indicator's width and offset are
 * `containerWidth / N`; the offset animates with `withTiming` when the selection
 * changes. The container measures its width via `onLayout`; before the first
 * measurement the indicator is zero-width (no flash).
 */
export function MaterialTabs<K extends string = string>({
  options,
  selectedKey,
  onSelect,
  accessibilityLabel,
}: MaterialTabsProps<K>) {
  const { m3 } = useTheme();
  const [containerWidth, setContainerWidth] = useState(0);

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    setContainerWidth(event.nativeEvent.layout.width);
  }, []);

  const tabCount = options.length;
  const activeIndex = Math.max(
    0,
    options.findIndex((option) => option.key === selectedKey),
  );
  // Equal-width slots: each tab and the indicator span containerWidth / N. Read
  // as primitives so the worklet's deps stay length-free (the count and width
  // are the only inputs that move the indicator).
  const slotWidth = tabCount > 0 ? containerWidth / tabCount : 0;

  // Animate only the horizontal offset; the width tracks the measured slot and
  // doesn't need easing. translateX lands the indicator under the active tab.
  const indicatorStyle = useAnimatedStyle(() => ({
    width: slotWidth,
    transform: [{ translateX: withTiming(activeIndex * slotWidth) }],
  }));

  const handleSelect = useCallback(
    (key: K) => {
      hapticSelection();
      onSelect(key);
    },
    [onSelect],
  );

  return (
    <View
      style={styles.container}
      onLayout={handleLayout}
      accessibilityRole="tablist"
      accessibilityLabel={accessibilityLabel}
    >
      <View style={styles.row}>
        {options.map((option) => (
          <MaterialTab
            key={option.key}
            label={option.label}
            selected={option.key === selectedKey}
            onPress={() => handleSelect(option.key)}
            rippleColor={m3.primary}
            activeColor={m3.primary}
            inactiveColor={m3.onSurfaceVariant}
          />
        ))}
      </View>
      {slotWidth > 0 ? (
        <Animated.View
          pointerEvents="none"
          style={[styles.indicator, { backgroundColor: m3.primary }, indicatorStyle]}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
  },
  row: {
    flexDirection: 'row',
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing[3],
  },
  label: {
    fontWeight: '600',
  },
  indicator: {
    position: 'absolute',
    left: 0,
    bottom: 0,
    height: INDICATOR_HEIGHT,
    borderTopLeftRadius: INDICATOR_HEIGHT,
    borderTopRightRadius: INDICATOR_HEIGHT,
  },
});
