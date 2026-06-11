import { useCallback } from 'react';
import { type LayoutChangeEvent, Platform, StyleSheet, View } from 'react-native';
import type { BottomTabBarProps } from 'expo-router/tabs';
import { Text } from '../Text';
import { PressableSurface } from '../PressableSurface';
import { useTheme } from '../../providers/theme-provider';
import { useSetMeasuredTabBarHeight } from '../../providers/tab-bar-height-provider';
import { brandColors as staticBrandColors } from '../../theme/colors';
import { material } from '../../theme/tokens';
import { MATERIAL_TAB_BAR_HEIGHT } from '../../theme/layout';

type RecordBadgeKind = 'session' | 'bluetooth';

/**
 * Material 3 bottom navigation bar — the JS tab bar for the Material UI variant
 * (the Liquid Glass variant uses the native `NativeTabs` instead). Built from the
 * existing design tokens so it reads as the same product: an opaque elevated
 * surface, a tonal active-indicator pill behind the focused icon, label below,
 * and a status dot for the Record tab. Icons/labels/badges come from each
 * screen's React Navigation options, so this stays a generic custom tab bar.
 */
export function MaterialTabBar({ state, descriptors, navigation, insets }: BottomTabBarProps) {
  const { systemColors, brandColors, m3 } = useTheme();
  // M3 navigation bar roles: the focused destination's icon sits on a
  // secondaryContainer active-indicator pill (onSecondaryContainer glyph), its
  // label lifts to onSurface, and inactive destinations use onSurfaceVariant for
  // both icon and label. These read correctly on the tonal M3 surface in both
  // schemes (the Paper palette resolves per scheme) — no manual alpha tinting.
  const activeIconColor = m3.onSecondaryContainer;
  const activeLabelColor = m3.onSurface;
  const inactiveColor = m3.onSurfaceVariant;
  const indicatorColor = m3.secondaryContainer;

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
          height: MATERIAL_TAB_BAR_HEIGHT + insets.bottom,
        },
      ]}
    >
      {state.routes.map((route, index) => {
        const { options } = descriptors[route.key];
        const focused = state.index === index;
        const label = typeof options.title === 'string' ? options.title : route.name;
        const iconColor = focused ? activeIconColor : inactiveColor;
        const labelColor = focused ? activeLabelColor : inactiveColor;
        const badgeKind: RecordBadgeKind | null =
          options.tabBarBadge === 'session' ? 'session' : options.tabBarBadge != null ? 'bluetooth' : null;

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
              {options.tabBarIcon?.({ focused, color: iconColor, size: 24 })}
              {badgeKind ? (
                <View
                  testID="badge"
                  style={[
                    badgeKind === 'session' ? styles.sessionBadge : styles.bluetoothBadge,
                    {
                      // Bluetooth remains the established green dot; a live
                      // session gets the brand-filled pill so the Record tab no
                      // longer uses one green indicator for two states.
                      backgroundColor: badgeKind === 'session' ? brandColors.primaryFill : staticBrandColors.success,
                      borderColor: systemColors.elevatedSurface,
                    },
                  ]}
                />
              ) : null}
            </View>
            <Text variant="caption2" color={labelColor} numberOfLines={1}>
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
  bluetoothBadge: {
    position: 'absolute',
    top: 2,
    right: 10,
    width: 9,
    height: 9,
    borderRadius: 5,
    borderWidth: 1.5,
  },
  sessionBadge: {
    position: 'absolute',
    top: 2,
    right: 8,
    width: 16,
    height: 9,
    borderRadius: 5,
    borderWidth: 1.5,
  },
});
