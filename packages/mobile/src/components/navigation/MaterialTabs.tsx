import { useCallback, useState } from 'react';
import { type LayoutChangeEvent, StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, withTiming } from 'react-native-reanimated';
import { Text } from '../Text';
import { PressableSurface } from '../PressableSurface';
import { hapticSelection } from '../../lib/haptics';
import { spacing } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';

// M3 primary-tab active-indicator: a 3dp underline with a rounded top, as wide
// as the active label (never narrower than 24dp) and centred in its tab slot.
// The container and each label measure themselves via onLayout.
const INDICATOR_HEIGHT = 3;
const INDICATOR_MIN_WIDTH = 24;

/**
 * Where the indicator sits for the active tab: label-wide (min 24dp), centred in
 * its equal-width slot. Returns null until both the slot and the label have been
 * measured, so the indicator never flashes at a guessed size.
 */
export function primaryIndicatorGeometry(
  slotWidth: number,
  activeIndex: number,
  labelWidth: number | undefined,
): { width: number; offset: number } | null {
  if (slotWidth <= 0 || labelWidth === undefined || labelWidth <= 0) return null;
  const width = Math.min(slotWidth, Math.max(INDICATOR_MIN_WIDTH, labelWidth));
  return { width, offset: activeIndex * slotWidth + (slotWidth - width) / 2 };
}

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
  onLabelLayout,
  rippleColor,
  activeColor,
  inactiveColor,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  onLabelLayout: (event: LayoutChangeEvent) => void;
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
      <Text
        variant="subheadline"
        color={selected ? activeColor : inactiveColor}
        style={styles.label}
        onLayout={onLabelLayout}
      >
        {label}
      </Text>
    </PressableSurface>
  );
}

/**
 * The sliding underline. A separate component so its animated style is first
 * created with measured values: mounting it only once geometry exists means the
 * first frame lands in place instead of easing out from zero width at x = 0.
 * After that, width and offset ease together, so the indicator stretches or
 * shrinks to the next label while it slides.
 */
function MaterialTabIndicator({ width, offset, color }: { width: number; offset: number; color: string }) {
  const indicatorStyle = useAnimatedStyle(() => ({
    width: withTiming(width),
    transform: [{ translateX: withTiming(offset) }],
  }));
  return (
    <Animated.View
      testID="material-tabs-indicator"
      pointerEvents="none"
      style={[styles.indicator, { backgroundColor: color }, indicatorStyle]}
    />
  );
}

/**
 * Material 3 primary tabs — a horizontal equal-width row of text labels with a
 * sliding active-indicator underline. The flat M3 counterpart of the Liquid
 * Glass `SegmentedControl`, sharing its generic prop API so call sites read the
 * same. Each tab is an equal-width slot (`containerWidth / N`); the indicator is
 * sized to the active label's measured width and centred in that slot, and both
 * its width and offset animate with `withTiming` when the selection changes.
 * Nothing renders until the container and the active label are measured.
 */
export function MaterialTabs<K extends string = string>({
  options,
  selectedKey,
  onSelect,
  accessibilityLabel,
}: MaterialTabsProps<K>) {
  const { m3 } = useTheme();
  const [containerWidth, setContainerWidth] = useState(0);
  const [labelWidths, setLabelWidths] = useState<Partial<Record<K, number>>>({});

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    setContainerWidth(event.nativeEvent.layout.width);
  }, []);

  const handleLabelLayout = useCallback((key: K, event: LayoutChangeEvent) => {
    const { width } = event.nativeEvent.layout;
    setLabelWidths((previous) => (previous[key] === width ? previous : { ...previous, [key]: width }));
  }, []);

  const tabCount = options.length;
  const activeIndex = Math.max(
    0,
    options.findIndex((option) => option.key === selectedKey),
  );
  // Equal-width slots: each tab spans containerWidth / N. Read as primitives so
  // the worklet's deps stay length-free.
  const slotWidth = tabCount > 0 ? containerWidth / tabCount : 0;
  // Read the width of the tab actually highlighted, so an unknown selectedKey
  // still underlines tab 0 like activeIndex does.
  const activeKey = options[activeIndex]?.key;
  const geometry = primaryIndicatorGeometry(
    slotWidth,
    activeIndex,
    activeKey === undefined ? undefined : labelWidths[activeKey],
  );

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
            onLabelLayout={(event) => handleLabelLayout(option.key, event)}
            rippleColor={m3.primary}
            activeColor={m3.primary}
            inactiveColor={m3.onSurfaceVariant}
          />
        ))}
      </View>
      {geometry ? <MaterialTabIndicator width={geometry.width} offset={geometry.offset} color={m3.primary} /> : null}
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
