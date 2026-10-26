import { memo, useCallback, useMemo, type ComponentProps } from 'react';
import { View, StyleSheet } from 'react-native';
import { useRouter, useSegments } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { PressableSurface } from '../PressableSurface';
import { SidebarWallCell } from './SidebarWallCell';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { hapticSelection } from '../../lib/haptics';
import { tabsActiveSegment } from '../../lib/route-segments';
import { SIDEBAR_WIDTH } from '../../theme/layout';
import { material, spacing } from '../../theme/tokens';

/**
 * Material 3 navigation rail — the Material-variant impl of the tablet
 * adaptive-shell sidebar (the Liquid Glass impl is `IpadSidebar`); the two are
 * routed by variant through `TabletSidebar`. It replaces the bottom tab bar at
 * `regular` width on an Android tablet (or on any tablet the user has switched to
 * the Material variant), and mirrors `MaterialTabBar`'s M3 roles laid out
 * vertically so the rail and the phone's bottom bar read as one nav system: a
 * `secondaryContainer` active-indicator pill behind the focused icon
 * (`onSecondaryContainer` glyph), the label lifting to `onSurface`, inactive
 * destinations in `onSurfaceVariant`.
 *
 * It drives navigation through the global Expo Router `router` (no tab-navigator
 * context needed) and reads the focused tab from `useSegments()` via
 * `tabsActiveSegment`. Compact width never mounts this; `_layout.tsx` renders the
 * Material tab bar there, so the phone UI is unchanged.
 */

type MaterialIconName = ComponentProps<typeof MaterialCommunityIcons>['name'];

type RailDestination = {
  /** Tab route segment under `(tabs)` — also the active-state key. */
  segment: string;
  /** Router path (typed routes are off, so a plain string is the href). */
  href: string;
  /** Focused (filled) glyph. */
  icon: MaterialIconName;
  /** Inactive (outline) glyph. */
  iconInactive: MaterialIconName;
  label: string;
};

const RAIL_ICON_SIZE = 24;

// Memoized so a focus change (navigation) only re-renders the two items whose
// `focused` flipped, not all six — the parent passes referentially-stable
// `destination`/`onPress`. Matches the "row is React.memo'd" nav-chrome guidance.
const RailItem = memo(function RailItem({
  destination,
  focused,
  onPress,
}: {
  destination: RailDestination;
  focused: boolean;
  onPress: (destination: RailDestination) => void;
}) {
  const { m3, brandColors } = useTheme();
  // M3 nav-rail roles, identical to MaterialTabBar: the focused destination's icon
  // sits on a secondaryContainer active-indicator pill (onSecondaryContainer glyph),
  // its label lifts to onSurface; inactive destinations use onSurfaceVariant for both.
  const iconColor = focused ? m3.onSecondaryContainer : m3.onSurfaceVariant;
  const labelColor = focused ? m3.onSurface : m3.onSurfaceVariant;
  const glyph = focused ? destination.icon : destination.iconInactive;
  const handlePress = useCallback(() => onPress(destination), [onPress, destination]);

  return (
    <PressableSurface
      onPress={handlePress}
      feedback="none"
      rippleColor={brandColors.primary}
      rippleBorderless
      accessibilityRole="tab"
      accessibilityState={{ selected: focused }}
      accessibilityLabel={destination.label}
      // Locale-independent handle for an Android tablet screenshot/maestro flow.
      testID={`tablet-rail-${destination.segment}`}
      style={styles.item}
    >
      <View style={[styles.indicator, focused ? { backgroundColor: m3.secondaryContainer } : null]}>
        <MaterialCommunityIcons name={glyph} size={RAIL_ICON_SIZE} color={iconColor} />
      </View>
      <Text variant="caption2" color={labelColor} numberOfLines={2} style={styles.label}>
        {destination.label}
      </Text>
    </PressableSurface>
  );
});

function MaterialNavigationRailComponent({ showWallCell = true }: { showWallCell?: boolean }) {
  const { t } = useTranslation('common');
  const { t: tSession } = useTranslation('session');
  const { t: tPlaylists } = useTranslation('playlists');
  const router = useRouter();
  const segments = useSegments();
  const insets = useSafeAreaInsets();
  const { m3, m3SurfaceContainers } = useTheme();

  const activeSegment = tabsActiveSegment(segments) ?? 'home';

  // Same destinations and i18n keys as IpadSidebar / MaterialTabBar so the rail,
  // the glass rail, and the phone bottom bar stay one nav system. Active/inactive
  // glyphs mirror the bottom bar's `materialTabIcon` pairs.
  const primary = useMemo<RailDestination[]>(
    () => [
      { segment: 'home', href: '/home', icon: 'home', iconInactive: 'home-outline', label: t('mobile.nav.home') },
      {
        segment: 'record',
        href: '/record',
        icon: 'record-circle',
        iconInactive: 'record-circle-outline',
        label: tSession('mobile.session.recordTab'),
      },
      {
        segment: 'discover',
        href: '/discover',
        icon: 'bookmark-multiple',
        iconInactive: 'bookmark-multiple-outline',
        label: tPlaylists('bottomTabBar.discover'),
      },
      // Climbs (search) is the last primary row, as it is the rightmost phone tab. It
      // deliberately uses the same glyph for both states — matching MaterialTabBar's
      // `materialTabIcon('magnify', 'magnify')`; MaterialCommunityIcons has no filled
      // `magnify` that reads as "search selected". The active pill carries the focus
      // state instead.
      { segment: 'climbs', href: '/climbs', icon: 'magnify', iconInactive: 'magnify', label: t('mobile.nav.climbs') },
    ],
    [t, tSession, tPlaylists],
  );
  const account = useMemo<RailDestination>(
    () => ({
      segment: 'profile',
      href: '/profile',
      icon: 'account-circle',
      iconInactive: 'account-circle-outline',
      label: t('mobile.nav.profile'),
    }),
    [t],
  );

  const handleNavigate = useCallback(
    (destination: RailDestination) => {
      hapticSelection();
      router.navigate(destination.href);
    },
    [router],
  );

  return (
    <View
      style={[
        styles.rail,
        {
          width: SIDEBAR_WIDTH,
          paddingTop: insets.top + spacing[3],
          paddingBottom: insets.bottom + spacing[3],
          // M3 depth by tone: the rail is chrome, a step above the content canvas.
          backgroundColor: m3SurfaceContainers.low,
          borderRightColor: m3.outlineVariant,
        },
      ]}
    >
      {/* Primary destinations form one tab group; the account row and the wall cell
          are labelled siblings outside it, so screen readers read a coherent set. */}
      <View style={styles.navGroup} accessibilityRole="tablist">
        {primary.map((destination) => (
          <RailItem
            key={destination.segment}
            destination={destination}
            focused={destination.segment === activeSegment}
            onPress={handleNavigate}
          />
        ))}
      </View>
      <View style={styles.spacer} />
      {/* Ambient "now on the wall" anchor, pinned above the account row. Hidden when
          the shell shows the full wall column/strip so there's one wall surface per
          layout. Reads the Material tonal `systemColors` on Android. */}
      {showWallCell ? <SidebarWallCell /> : null}
      {/* Profile is a nav destination too, so its `tab` role must live inside a
          tablist — its own here, keeping the ambient wall cell (a plain button)
          outside so it doesn't split the primary tab run. */}
      <View style={styles.accountGroup} accessibilityRole="tablist">
        <RailItem destination={account} focused={account.segment === activeSegment} onPress={handleNavigate} />
      </View>
    </View>
  );
}

export const MaterialNavigationRail = memo(MaterialNavigationRailComponent);

const styles = StyleSheet.create({
  rail: {
    flexDirection: 'column',
    alignItems: 'center',
    gap: spacing[1],
    borderRightWidth: StyleSheet.hairlineWidth,
  },
  navGroup: {
    width: '100%',
    alignItems: 'center',
    gap: spacing[1],
  },
  accountGroup: {
    width: '100%',
    alignItems: 'center',
  },
  item: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing[2],
    gap: 4,
    width: '100%',
  },
  // M3 nav-rail active-indicator pill — fixed size, tonal fill only when focused.
  indicator: {
    width: material.navRail.activeIndicatorWidth,
    height: material.navRail.activeIndicatorHeight,
    borderRadius: material.navRail.activeIndicatorRadius,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    textAlign: 'center',
    paddingHorizontal: spacing[1],
  },
  spacer: {
    flex: 1,
  },
});
