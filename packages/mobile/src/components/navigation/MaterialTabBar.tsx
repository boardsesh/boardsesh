import { useCallback } from 'react';
import { type LayoutChangeEvent, Platform, StyleSheet, View } from 'react-native';
import type { BottomTabBarProps } from 'expo-router/tabs';
import { Text } from '../Text';
import { PressableSurface } from '../PressableSurface';
import { useTheme } from '../../providers/theme-provider';
import { useSetMeasuredTabBarHeight } from '../../providers/tab-bar-height-provider';
import { brandColors as staticBrandColors, withAlpha } from '../../theme/colors';
import { material } from '../../theme/tokens';
import { TAB_BAR_HEIGHT } from '../../theme/layout';

/**
 * Material 3 bottom navigation bar — the JS tab bar for the Material UI variant
 * (the Liquid Glass variant uses the native `NativeTabs` instead). Built from the
 * existing design tokens so it reads as the same product: an opaque elevated
 * surface, a tonal active-indicator pill behind the focused icon, label below,
 * and a status dot for the Record tab. Icons/labels/badges come from each
 * screen's React Navigation options, so this stays a generic custom tab bar.
 */
export function MaterialTabBar({ state, descriptors, navigation, insets }: BottomTabBarProps) {
  const { systemColors, brandColors } = useTheme();
  // Softened active state (closer to M3, which tints the indicator gently rather
  // than using full primary): a lighter violet pill + a muted violet icon/label.
  // Brand colours resolve per scheme (lifted #A78BFA in dark), so the active tab
  // stays legible on the dark Material bar instead of dimming to the dark fill.
  const activeColor = withAlpha(brandColors.primary, 0.8);
  const inactiveColor = systemColors.secondaryLabel;
  const indicatorColor = withAlpha(brandColors.primary, 0.1);

  // Publish the real rendered height so the root-level queue bar docks flush against
  // it (rather than re-deriving the tab-bar top from TAB_BAR_HEIGHT + inset). #2611.
  const setMeasuredTabBarHeight = useSetMeasuredTabBarHeight();
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => setMeasuredTabBarHeight(event.nativeEvent.layout.height),
    [setMeasuredTabBarHeight],
  );

  return (
    <View
      onLayout={handleLayout}
      style={[
        styles.bar,
        {
          backgroundColor: systemColors.elevatedSurface,
          borderTopColor: systemColors.separator,
          paddingBottom: insets.bottom,
          height: TAB_BAR_HEIGHT + insets.bottom,
        },
      ]}
    >
      {state.routes.map((route, index) => {
        const { options } = descriptors[route.key];
        const focused = state.index === index;
        const label = typeof options.title === 'string' ? options.title : route.name;
        const color = focused ? activeColor : inactiveColor;

        const onPress = () => {
          const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
          if (!focused && !event.defaultPrevented) {
            navigation.navigate(route.name);
          }
        };
        const onLongPress = () => {
          navigation.emit({ type: 'tabLongPress', target: route.key });
        };

        return (
          <PressableSurface
            key={route.key}
            onPress={onPress}
            onLongPress={onLongPress}
            feedback="none"
            rippleColor={brandColors.primary}
            rippleBorderless
            accessibilityRole="tab"
            accessibilityState={{ selected: focused }}
            accessibilityLabel={label}
            style={styles.item}
          >
            <View style={[styles.indicator, focused && { backgroundColor: indicatorColor }]}>
              {options.tabBarIcon?.({ focused, color, size: 24 })}
              {options.tabBarBadge != null ? (
                <View
                  testID="badge"
                  style={[
                    styles.badge,
                    // Badge dot is a FILL (no text on it) → static light brand
                    // success, not the scheme-lifted theme value.
                    { backgroundColor: staticBrandColors.success, borderColor: systemColors.elevatedSurface },
                  ]}
                />
              ) : null}
            </View>
            <Text variant="caption2" color={color} numberOfLines={1}>
              {label}
            </Text>
          </PressableSurface>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    ...Platform.select({
      android: { elevation: material.navBar.surfaceElevation },
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: -2 }, shadowOpacity: 0.08, shadowRadius: 8 },
      default: {},
    }),
  },
  item: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 6,
    gap: 4,
  },
  // M3 active-indicator pill — fixed size, tonal fill only when focused.
  indicator: {
    width: material.navBar.activeIndicatorWidth,
    height: material.navBar.activeIndicatorHeight,
    borderRadius: material.navBar.activeIndicatorRadius,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    top: 2,
    right: 10,
    width: 9,
    height: 9,
    borderRadius: 5,
    borderWidth: 1.5,
  },
});
