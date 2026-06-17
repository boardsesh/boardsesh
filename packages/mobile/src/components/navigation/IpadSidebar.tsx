import { memo, useCallback, useMemo, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { useRouter, useSegments } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GlassSurface } from '../GlassSurface';
import { PressableSurface } from '../PressableSurface';
import { SidebarWallCell } from './SidebarWallCell';
import { Icon } from '../Icon';
import { Text } from '../Text';
import type { IconName } from '../icon-map';
import { useTheme } from '../../providers/theme-provider';
import { hapticSelection } from '../../lib/haptics';
import { tabsActiveSegment } from '../../lib/route-segments';
import {
  SIDEBAR_WIDTH,
  SIDEBAR_NAV_PILL_HEIGHT,
  SIDEBAR_NAV_PILL_WIDTH,
  SIDEBAR_NAV_ICON_SIZE,
} from '../../theme/layout';
import { spacing, borderRadius } from '../../theme/tokens';

/**
 * iPad adaptive-shell sidebar — the glass left rail that replaces the bottom tab
 * bar at `regular` width (see `size-class.ts`). It drives navigation through the
 * global Expo Router `router` (so it needs no tab-navigator context) and reads
 * the focused tab from `useSegments()[1]` — segment 0 is the `(tabs)` group.
 * Compact width never mounts this; `_layout.tsx` renders the native tab bar
 * there, so the phone UI is unchanged.
 *
 * The selected-climb pane lives to the right of this rail; the bottom
 * PersistentQueueBar stays compact-only. The rail owns only navigation plus the
 * compact board-presence cell.
 */

type SidebarDestination = {
  /** Tab route segment under `(tabs)` — also the active-state key. */
  segment: string;
  /** Router path (typed routes are off, so a plain string is the href). */
  href: string;
  icon: IconName;
  label: string;
};

function SidebarItem({
  destination,
  focused,
  onPress,
}: {
  destination: SidebarDestination;
  focused: boolean;
  onPress: (destination: SidebarDestination) => void;
}) {
  const { systemColors } = useTheme();
  // Pointer-hover / keyboard-focus on the iPad rail (no-op on touch). Treated as
  // a single "active-ish" cue: it brightens the glyph and fills the pill, the
  // same affordance selection uses, so hovering/focusing previews selection.
  const [interactive, setInteractive] = useState(false);
  const active = focused || interactive;
  // Neutral chrome glyphs, matching NativeTabs / MaterialTabBar (the systemFill
  // pill is the sole active affordance, not a brand tint). See
  // docs/ai-design-guidelines.md — chrome carries state with fills, not colour.
  const tint = active ? systemColors.label : systemColors.secondaryLabel;
  const handlePress = useCallback(() => onPress(destination), [onPress, destination]);
  const handleInteractiveOn = useCallback(() => setInteractive(true), []);
  const handleInteractiveOff = useCallback(() => setInteractive(false), []);

  return (
    <PressableSurface
      onPress={handlePress}
      onHoverIn={handleInteractiveOn}
      onHoverOut={handleInteractiveOff}
      onFocus={handleInteractiveOn}
      onBlur={handleInteractiveOff}
      feedback="scale"
      accessibilityRole="tab"
      accessibilityState={{ selected: focused }}
      accessibilityLabel={destination.label}
      style={styles.item}
    >
      <View style={[styles.iconPill, active ? { backgroundColor: systemColors.fill } : null]}>
        <Icon name={destination.icon} size={SIDEBAR_NAV_ICON_SIZE} color={tint} />
      </View>
      <Text variant="caption2" color={tint} numberOfLines={2} style={styles.label}>
        {destination.label}
      </Text>
    </PressableSurface>
  );
}

function IpadSidebarComponent({ showWallCell = true }: { showWallCell?: boolean }) {
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
      // Always acknowledge the tap with a haptic so the active row is never a dead
      // control. `router.navigate` to a tab already in the stack pops it back to
      // the tab root (the iPhone tab-bar active-tap convention); a fresh tab just
      // switches. Scroll-to-top on re-tap is a future refinement.
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
      {/* The primary destinations form one tab group; the account row and the
          wall cell are labelled siblings outside it, so VoiceOver reads a coherent
          set rather than a flat run of tabs split by a button. */}
      <View style={styles.navGroup} accessibilityRole="tablist">
        {primary.map((destination) => (
          <SidebarItem
            key={destination.segment}
            destination={destination}
            focused={destination.segment === activeSegment}
            onPress={handleNavigate}
          />
        ))}
      </View>
      <View style={styles.spacer} />
      {/* Ambient "now on the wall" anchor, pinned above the account row. Hidden
          when the shell shows the full wall column (landscape) so there's one
          wall surface per layout. */}
      {showWallCell ? <SidebarWallCell /> : null}
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
  navGroup: {
    width: '100%',
    alignItems: 'center',
    gap: spacing[1],
  },
  item: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing[2],
    gap: 4,
    width: '100%',
  },
  iconPill: {
    width: SIDEBAR_NAV_PILL_WIDTH,
    height: SIDEBAR_NAV_PILL_HEIGHT,
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
