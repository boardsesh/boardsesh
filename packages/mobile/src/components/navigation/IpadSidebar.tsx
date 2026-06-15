import { memo, useCallback, useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { useRouter, useSegments } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GlassSurface } from '../GlassSurface';
import { PressableSurface } from '../PressableSurface';
import { Icon } from '../Icon';
import { Text } from '../Text';
import type { IconName } from '../icon-map';
import { useTheme } from '../../providers/theme-provider';
import { hapticSelection } from '../../lib/haptics';
import { tabsActiveSegment } from '../../lib/route-segments';
import { SIDEBAR_WIDTH } from '../../theme/layout';
import { spacing, borderRadius } from '../../theme/tokens';

/**
 * iPad adaptive-shell sidebar — the glass left rail that replaces the bottom tab
 * bar at `regular` width (see `size-class.ts`). It drives navigation through the
 * global Expo Router `router` (so it needs no tab-navigator context) and reads
 * the focused tab from `useSegments()[1]` — segment 0 is the `(tabs)` group.
 * Compact width never mounts this; `_layout.tsx` renders the native tab bar
 * there, so the phone UI is unchanged.
 *
 * The current-climb "now playing" chrome stays on the existing floating
 * `PersistentQueueBar` for now; moving it into a sidebar footer is a follow-up.
 */

type SidebarDestination = {
  /** Tab route segment under `(tabs)` — also the active-state key. */
  segment: string;
  /** Router path (typed routes are off, so a plain string is the href). */
  href: string;
  icon: IconName;
  label: string;
};

const NAV_ICON_SIZE = 26;

function SidebarItem({
  destination,
  focused,
  onPress,
}: {
  destination: SidebarDestination;
  focused: boolean;
  onPress: (destination: SidebarDestination) => void;
}) {
  const { systemColors, brandColors } = useTheme();
  const tint = focused ? brandColors.primary : systemColors.secondaryLabel;
  const handlePress = useCallback(() => onPress(destination), [onPress, destination]);

  return (
    <PressableSurface
      onPress={handlePress}
      feedback="scale"
      accessibilityRole="tab"
      accessibilityState={{ selected: focused }}
      accessibilityLabel={destination.label}
      style={styles.item}
    >
      <View style={[styles.iconPill, focused ? { backgroundColor: systemColors.fill } : null]}>
        <Icon name={destination.icon} size={NAV_ICON_SIZE} color={tint} />
      </View>
      <Text variant="caption2" color={tint} numberOfLines={1} style={styles.label}>
        {destination.label}
      </Text>
    </PressableSurface>
  );
}

function IpadSidebarComponent() {
  const { t } = useTranslation('common');
  const { t: tSession } = useTranslation('session');
  const { t: tPlaylists } = useTranslation('playlists');
  const router = useRouter();
  const segments = useSegments();
  const insets = useSafeAreaInsets();
  const { systemColors } = useTheme();

  // Default to the cold-start tab so the rail always shows a selection on first
  // paint. `tabsActiveSegment` reads the focused tab without indexing the
  // route-typed tuple directly (see route-segments.ts).
  const activeSegment = tabsActiveSegment(segments) ?? 'home';

  // Primary destinations sit at the top; the account row pins to the bottom (HIG
  // sidebar convention). Labels reuse the same i18n keys as the tab bars.
  const primary = useMemo<SidebarDestination[]>(
    () => [
      { segment: 'home', href: '/home', icon: 'home', label: t('mobile.nav.home') },
      { segment: 'climbs', href: '/climbs', icon: 'search', label: t('mobile.nav.climbs') },
      { segment: 'record', href: '/record', icon: 'record', label: tSession('mobile.session.recordTab') },
      { segment: 'discover', href: '/discover', icon: 'discover', label: tPlaylists('bottomTabBar.discover') },
    ],
    [t, tSession, tPlaylists],
  );
  const account = useMemo<SidebarDestination>(
    () => ({ segment: 'profile', href: '/profile', icon: 'profile', label: t('mobile.nav.profile') }),
    [t],
  );

  const handleNavigate = useCallback(
    (destination: SidebarDestination) => {
      // Only buzz when the tab actually changes — re-tapping the active row is a
      // no-op (a future refinement can pop the tab's stack to root instead).
      if (destination.segment !== activeSegment) hapticSelection();
      router.navigate(destination.href);
    },
    [router, activeSegment],
  );

  return (
    <View
      style={[
        styles.rail,
        {
          width: SIDEBAR_WIDTH,
          paddingTop: insets.top + spacing[3],
          paddingBottom: insets.bottom + spacing[3],
          borderRightColor: systemColors.separator,
        },
      ]}
    >
      {/* Glass fill behind the rail; nav items render as siblings on top. */}
      <GlassSurface
        style={StyleSheet.absoluteFill}
        fallbackColor={systemColors.secondaryBackground}
        pointerEvents="none"
      />
      {primary.map((destination) => (
        <SidebarItem
          key={destination.segment}
          destination={destination}
          focused={destination.segment === activeSegment}
          onPress={handleNavigate}
        />
      ))}
      <View style={styles.spacer} />
      <SidebarItem destination={account} focused={account.segment === activeSegment} onPress={handleNavigate} />
    </View>
  );
}

export const IpadSidebar = memo(IpadSidebarComponent);

const styles = StyleSheet.create({
  rail: {
    flexDirection: 'column',
    alignItems: 'center',
    gap: spacing[1],
    borderRightWidth: StyleSheet.hairlineWidth,
  },
  item: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing[2],
    gap: 4,
    width: '100%',
  },
  iconPill: {
    width: 48,
    height: 34,
    borderRadius: borderRadius.lg,
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
