import { useCallback } from 'react';
import { type LayoutChangeEvent, Platform, StyleSheet, View } from 'react-native';
import type { BottomTabBarProps } from 'expo-router/tabs';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { Text } from '../Text';
import { PressableSurface } from '../PressableSurface';
import { useTheme } from '../../providers/theme-provider';
import { useSetMeasuredTabBarHeight } from '../../providers/tab-bar-height-provider';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { tabBarHiddenProgress } from '../../lib/tab-bar-hide-progress';
import { useTabBarHidden } from '../../lib/tab-bar-visibility-store';
import { brandColors as staticBrandColors, withAlpha } from '../../theme/colors';
import { material } from '../../theme/tokens';
import { MATERIAL_TAB_BAR_HEIGHT } from '../../theme/layout';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';
import { isLiveTabBadge } from './tab-badge';

/**
 * Material 3 Expressive short navigation bar — the JS tab bar for the Material UI
 * variant (the Liquid Glass variant uses the native `NativeTabs` instead). Built
 * from the existing design tokens so it reads as the same product: a 64dp opaque
 * elevated surface, a 56×32 tonal pill behind the focused icon, label below
 * (capped at CHROME_LABEL_MAX_FONT_SCALE so it fits the fixed height; the full
 * label stays in the accessibility label), and a status dot for the Record tab. Icons/labels/badges come from
 * each screen's React Navigation options, so this stays a generic custom tab
 * bar.
 */
export function MaterialTabBar({ state, descriptors, emitter, navigateToTab, insets }: BottomTabBarProps) {
  const { systemColors, colorScheme, m3 } = useTheme();
  // M3 navigation bar roles: the focused destination's icon sits on a
  // secondaryContainer active-indicator pill (onSecondaryContainer glyph), its
  // label takes secondary (M3 ItemActiveLabelTextColor), and inactive destinations use onSurfaceVariant for
  // both icon and label. These read correctly on the tonal M3 surface in both
  // schemes (the Paper palette resolves per scheme) — no manual alpha tinting.
  const activeIconColor = m3.onSecondaryContainer;
  const activeLabelColor = m3.secondary;
  const inactiveColor = m3.onSurfaceVariant;
  const indicatorColor = m3.secondaryContainer;

  // Publish the real rendered height so the root-level queue bar docks flush against
  // it (rather than re-deriving the tab-bar top from TAB_BAR_HEIGHT + inset). #2611.
  const setMeasuredTabBarHeight = useSetMeasuredTabBarHeight();
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => setMeasuredTabBarHeight(event.nativeEvent.layout.height),
    [setMeasuredTabBarHeight],
  );

  // On an Android phone's tab root the bar is drawn over the screen so it can
  // slide away on scroll (the metrics decide, so the reserves always agree).
  // There it reads like Spotify's bar: a mostly opaque m3.surface fill behind
  // the icons and labels (content is faint there, never legible), no hairline, no
  // shadow, and a 24dp fade above its top edge so the list dissolves into the
  // bar instead of running under its labels. Everywhere else it sits in flow,
  // opaque, as before.
  const { jsBarOverlaysContent: overlay } = useBottomChromeMetrics();
  const overlaySurfaceAlpha = material.navBar.overlaySurfaceAlpha[colorScheme];
  const hidden = useTabBarHidden() && overlay;
  const barHeight = MATERIAL_TAB_BAR_HEIGHT + insets.bottom;
  const slideStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: overlay ? tabBarHiddenProgress.value * barHeight : 0 }],
  }));

  return (
    <Animated.View
      onLayout={handleLayout}
      // A hidden bar is off screen: no touches, and out of the TalkBack order.
      pointerEvents={hidden ? 'none' : 'auto'}
      importantForAccessibility={hidden ? 'no-hide-descendants' : 'auto'}
      style={[
        styles.bar,
        overlay
          ? [styles.overlayBar, { backgroundColor: withAlpha(m3.surface, overlaySurfaceAlpha) }]
          : {
              backgroundColor: systemColors.elevatedSurface,
              borderTopColor: systemColors.separator,
            },
        { paddingBottom: insets.bottom, height: barHeight },
        slideStyle,
      ]}
    >
      {overlay ? (
        // A child of the bar, so it slides away with it; it never takes a touch.
        <LinearGradient
          testID="tab-bar-fade"
          pointerEvents="none"
          colors={[withAlpha(m3.surface, 0), withAlpha(m3.surface, overlaySurfaceAlpha)]}
          style={styles.overlayFade}
        />
      ) : null}
      {state.routes.map((route, index) => {
        const { options } = descriptors[route.key];
        // expo-router turns a screen's `href: null` into `tabBarItemStyle:
        // { display: 'none' }` (the iPad-only /wall destination). This custom bar
        // renders every route in `state.routes`, so without this filter a hidden
        // route would show as a phone tab button. Skip it — the default RN tab bar
        // hides it via `tabBarButton`, which a custom bar doesn't honor.
        if (StyleSheet.flatten(options.tabBarItemStyle)?.display === 'none') return null;
        const focused = state.index === index;
        const label = typeof options.title === 'string' ? options.title : route.name;
        const iconColor = focused ? activeIconColor : inactiveColor;
        const labelColor = focused ? activeLabelColor : inactiveColor;

        const onPress = () => {
          const event = emitter.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
          if (!focused && !event.defaultPrevented) {
            navigateToTab(route.key);
          }
        };
        const onLongPress = () => {
          emitter.emit({ type: 'tabLongPress', target: route.key });
        };

        return (
          <PressableSurface
            key={route.key}
            onPress={onPress}
            onLongPress={onLongPress}
            feedback="none"
            // No rippleColor: PressableSurface takes the theme's neutral
            // onSurface ripple, a grey state layer on the grey bar.
            rippleBorderless
            accessibilityRole="tab"
            accessibilityState={{ selected: focused }}
            accessibilityLabel={label}
            style={styles.item}
          >
            <View style={styles.indicator}>
              {/* Opacity toggle, not a color swap — Android needs radius+color set together from mount. */}
              <View
                testID="indicator"
                style={[styles.indicatorFill, { backgroundColor: indicatorColor, opacity: focused ? 1 : 0 }]}
              />
              {options.tabBarIcon?.({ focused, color: iconColor, size: 24 })}
              {options.tabBarBadge != null ? (
                <View
                  testID="badge"
                  style={[
                    styles.badge,
                    // Badge dot is a FILL (no text on it) → static light brand
                    // colors, not the scheme-lifted theme value. Record's screen
                    // options carry a state marker (not display text) on
                    // `tabBarBadge` to tell a live session from a merely-connected
                    // board; the producer/consumer contract lives in ./tab-badge.
                    // Any other badge value keeps the standard green.
                    {
                      backgroundColor: isLiveTabBadge(options.tabBarBadge)
                        ? staticBrandColors.live
                        : staticBrandColors.success,
                      borderColor: systemColors.elevatedSurface,
                    },
                  ]}
                />
              ) : null}
            </View>
            <Text
              variant="footnote"
              color={labelColor}
              numberOfLines={1}
              maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
              style={styles.label}
            >
              {label}
            </Text>
          </PressableSurface>
        );
      })}
    </Animated.View>
  );
}

// How opaque the overlay bar's surface is lives in `material.navBar.overlaySurfaceAlpha`
// (per scheme): content stays faintly visible behind the icons and labels but never
// legible, and the active label clears 4.5:1 over white or black content. The fade
// above ends on it.
// The soft edge above the overlay bar: clear at the top, the bar's own fill
// where it meets the bar, so content fades out before it reaches the labels.
const OVERLAY_FADE_HEIGHT = 24;

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
  // Drawn over the tab root: absolute, flat, a mostly opaque surface (set inline).
  overlayBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopWidth: 0,
    elevation: 0,
  },
  // Hangs above the bar's top edge; the bar does not clip it.
  overlayFade: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: -OVERLAY_FADE_HEIGHT,
    height: OVERLAY_FADE_HEIGHT,
  },
  item: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  // Active-indicator pill — fixed size, centers the icon over the fill layer below.
  indicator: {
    width: material.navBar.activeIndicatorWidth,
    height: material.navBar.activeIndicatorHeight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // The tonal fill itself — color is constant, only opacity toggles with focus.
  indicatorFill: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: material.navBar.activeIndicatorRadius,
  },
  // M3 LabelMedium (12/16, weight 500), the nav bar label role: the Material
  // footnote token is 12/16 at 400, so only the weight is lifted here.
  label: { fontWeight: '500' },
  // Dot on the icon's top-end corner: the 24dp icon sits centred in the 56×32
  // pill (x 16–40, y 4–28), so the dot straddles that corner.
  badge: {
    position: 'absolute',
    top: 2,
    end: 12,
    width: 9,
    height: 9,
    borderRadius: 5,
    borderWidth: 1.5,
  },
});
