import type { ComponentProps } from 'react';
import { Platform, StyleSheet, View, useWindowDimensions, type ColorValue } from 'react-native';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { Tabs } from 'expo-router';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useTranslation } from 'react-i18next';
import { useBluetoothConnectedStatus } from '../../src/lib/ble/bluetooth-status-store';
import { useQueueSessionId } from '../../src/providers/queue-provider';
import { useStickyAccessoryPresence } from '../../src/hooks/use-sticky-accessory-presence';
import { QueueBottomAccessory } from '../../src/components/queue-control/QueueBottomAccessory';
import { MaterialTabBar } from '../../src/components/navigation/MaterialTabBar';
import { useTheme } from '../../src/providers/theme-provider';
import { brandColors } from '../../src/theme/colors';
import { useNativeAccessoryActive, useNativeTabBar } from '../../src/hooks/use-bottom-accessory';
import { useInsideTabs } from '../../src/hooks/use-inside-tabs';
import { useDeviceLayout } from '../../src/hooks/use-device-layout';
import { IpadSidebar } from '../../src/components/navigation/IpadSidebar';
import { IpadPlayPane } from '../../src/components/play-drawer/IpadPlayPane';
import { IpadWallColumn } from '../../src/components/board-presence/IpadWallColumn';
import { useBoardPresenceControls } from '../../src/providers/board-presence-provider';
import { useActiveBoard } from '../../src/lib/graphql/use-active-board';
import { resolveWallSurface, WALL_COLUMN_WIDTH, DETAIL_PANE_WIDTH_WITH_WALL } from '../../src/theme/size-class';
import { SIDEBAR_WIDTH } from '../../src/theme/layout';

// Cold-start on Home: the leftmost tab carries the beta shelf and followed
// activity feed, while Climbs remains the search surface one tab over. Drives
// the default-selected tab in both the native-tabs and Material `Tabs` variants.
export const unstable_settings = { initialRouteName: 'home' };

type TabIconProps = { focused: boolean; color: ColorValue; size: number };
type MaterialIconName = ComponentProps<typeof MaterialCommunityIcons>['name'];

// Material (MaterialCommunityIcons) glyphs for the JS tab bar, mirroring the
// SF Symbols / md hints used by the native tab bar. Rendered on all platforms in
// the Material variant so it reads as Material even on iOS.
const materialTabIcon =
  (active: MaterialIconName, inactive: MaterialIconName) =>
  ({ focused, color, size }: TabIconProps) => (
    <MaterialCommunityIcons name={focused ? active : inactive} color={color} size={size} />
  );

// The iPad shell hides the Tabs navigator's own bar (the glass sidebar carries
// navigation), while the navigator still owns routing + per-tab state.
const renderHiddenTabBar = () => null;

/**
 * Bottom tabs. The system Liquid Glass tab bar (`expo-router/unstable-native-tabs`)
 * — with a native `BottomAccessory` platter for the current climb + tick — is used
 * only on the Liquid Glass variant AND a glass-capable device (iOS 26). Everywhere
 * else (Material, plus Liquid Glass on iOS < 26 / Android) falls back to a JS `Tabs`
 * navigator with the Material 3 `MaterialTabBar`; its climb/tick chrome rides the
 * floating `PersistentQueueBar` (the native accessory is iOS-26-only).
 */
export default function TabLayout() {
  const { t } = useTranslation('common');
  const { t: tPlaylists } = useTranslation('playlists');
  const { t: tSession } = useTranslation('session');
  const { systemColors } = useTheme();
  const nativeTabBar = useNativeTabBar();
  const nativeAccessoryActive = useNativeAccessoryActive();

  // Record-tab status cue: a badge when a board is connected over Bluetooth or a
  // session is live.
  const isBluetoothConnected = useBluetoothConnectedStatus();
  // sessionId-only subscription: the tab layout renders the whole NativeTabs
  // tree inline, so reading the volatile useQueue() here re-rendered every tab
  // on every queue mutation. useQueueSessionId only changes on session start/end.
  const { sessionId } = useQueueSessionId();
  // Presence-only selector (flips just when a climb appears/disappears, not on
  // queue mutations or climb-to-climb nav), so gating the accessory mount on it
  // doesn't re-render the tab tree on every queue change. Wall-aware: stays true
  // across a board-level climb change (only the climb identity changes), so the
  // UIKit accessory host is never unmounted/remounted mid-change — which is what
  // left a stale snapshot stacked under the new one (doubled text). The sticky
  // wrapper additionally holds the mount across a brief presence blip (board
  // reconnect / queue rehydrate), so those don't churn the host either.
  const hasCurrentClimb = useStickyAccessoryPresence();
  // Route term on the same mount gate: a root-level push (session detail) or modal
  // slides the whole tab bar — and its bottom accessory — off screen. Without this,
  // React leaves the accessory host mounted underneath, so UIKit keeps a stale glass
  // platter that re-presents stacked under the fresh one on return (doubled, offset
  // text). Unmounting on tab-group exit releases the host cleanly; bottom-chrome
  // arbitration already assumes the native accessory is gone off-tabs, so this just
  // makes the real mount match. `isTabsRoute` keys on segments[0] only, so intra-tab
  // navigation doesn't toggle it.
  const insideTabs = useInsideTabs();
  const showRecordBadge = isBluetoothConnected || sessionId !== null;
  const eagerMountRecord = Platform.OS === 'android';
  // Regular-width iPad opts into the sidebar shell; compact width (every iPhone,
  // a narrow iPad split) keeps the native / Material tab bars below verbatim.
  const deviceLayout = useDeviceLayout();
  const { width: windowWidth } = useWindowDimensions();
  // The live wall gets a dedicated column in landscape (room for sidebar + browse
  // list + detail pane + wall) and falls back to a strip atop the pane in portrait
  // (see resolveWallSurface). Gated on a bound board so an empty column never sits
  // as dead space. The presence controls context only changes on bind/unbind, not
  // on wall climb updates, so this doesn't re-render the shell per wall event.
  const { enabled: boardPresenceEnabled, boardId: boardPresenceBoardId } = useBoardPresenceControls();
  // The column only renders content when a board config is resolved (the wall
  // panel reads it via the host). `boardPresenceBoardId` can be set from the BLE
  // serial before/without an active board, so gate on the active board too — else
  // the column View reserves 300pt while `IpadWallColumn` renders null (dead space).
  const { data: activeBoard } = useActiveBoard();
  const wallSurface = resolveWallSurface({
    width: windowWidth,
    widthClass: deviceLayout.widthClass,
    sidebarWidth: SIDEBAR_WIDTH,
  });
  const showWallColumn =
    wallSurface === 'column' && boardPresenceEnabled && boardPresenceBoardId !== null && activeBoard != null;
  // The detail (play) pane scales with the window (clamped 320–400pt) but narrows
  // to a fixed width when the wall column shares the row, so the browse list keeps
  // room.
  const playPaneWidth = showWallColumn
    ? DETAIL_PANE_WIDTH_WITH_WALL
    : Math.round(Math.min(400, Math.max(320, windowWidth * 0.34)));

  // The five tab screens are identical across the JS `Tabs` variants (Material
  // bar vs. the hidden-bar iPad shell), so share one definition. A flat keyed
  // ARRAY (not a Fragment) — Expo Router walks the navigator's direct children
  // for `Tabs.Screen`, and a Fragment wrapper makes it ignore their `options`
  // (titles/icons/badge/lazy). The NativeTabs path uses its own Trigger API below
  // and does not consume this.
  const tabScreens = [
    <Tabs.Screen
      key="home"
      name="home"
      options={{ title: t('mobile.nav.home'), tabBarIcon: materialTabIcon('home', 'home-outline') }}
    />,
    <Tabs.Screen
      key="climbs"
      name="climbs"
      options={{ title: t('mobile.nav.climbs'), tabBarIcon: materialTabIcon('magnify', 'magnify') }}
    />,
    <Tabs.Screen
      key="record"
      name="record"
      options={{
        title: tSession('mobile.session.recordTab'),
        tabBarIcon: materialTabIcon('record-circle', 'record-circle-outline'),
        tabBarBadge: showRecordBadge ? '' : undefined,
        // Android can stall the first lazy mount of this nested stack,
        // leaving the Record tab blank until another tab forces a remount.
        lazy: eagerMountRecord ? false : undefined,
      }}
    />,
    <Tabs.Screen
      key="discover"
      name="discover"
      options={{
        title: tPlaylists('bottomTabBar.discover'),
        tabBarIcon: materialTabIcon('bookmark-multiple', 'bookmark-multiple-outline'),
      }}
    />,
    <Tabs.Screen
      key="profile"
      name="profile"
      options={{
        title: t('mobile.nav.profile'),
        tabBarIcon: materialTabIcon('account-circle', 'account-circle-outline'),
      }}
    />,
  ];

  // Regular-width iPad: a glass left sidebar replaces the bottom tab bar, with
  // each tab rendered single-column to its right. The Tabs navigator still owns
  // routing + per-tab state; we hide its bar and drive it from the sidebar (the
  // global router). Bottom chrome collapses to the safe-area inset via the
  // `usesSidebar` branch in computeBottomChromeMetrics.
  if (deviceLayout.widthClass === 'regular') {
    return (
      <View style={styles.shell}>
        <IpadSidebar showWallCell={!showWallColumn} />
        <View style={styles.shellContent}>
          <Tabs tabBar={renderHiddenTabBar} screenOptions={{ headerShown: false }}>
            {tabScreens}
          </Tabs>
        </View>
        {/* Persistent right column: the PlayDrawer for the SELECTED climb (iPad
            master-detail). Replaces the floating accessory/queue bar on the shell. */}
        <View style={[styles.playPane, { width: playPaneWidth, borderLeftColor: systemColors.separator }]}>
          <IpadPlayPane />
        </View>
        {/* Dedicated "Now on the wall" column — landscape only, where the width
            budget leaves room for it (see resolveWallSurface). In portrait the wall
            rides a strip atop the pane (IpadPlayPane) instead. */}
        {showWallColumn ? (
          <View style={[styles.wallColumn, { width: WALL_COLUMN_WIDTH, borderLeftColor: systemColors.separator }]}>
            <IpadWallColumn />
          </View>
        ) : null}
      </View>
    );
  }

  if (!nativeTabBar) {
    return (
      <Tabs tabBar={(props) => <MaterialTabBar {...props} />} screenOptions={{ headerShown: false }}>
        {tabScreens}
      </Tabs>
    );
  }

  return (
    // `minimizeBehavior="onScrollDown"` relies on UIKit finding the climbs
    // FlashList's nested scroll view, which it can't by default — that fallback
    // lives in patches/react-native-screens@4.25.2.patch. `vp run check:mobile-patches`
    // (CI) fails the build if that patch ever stops applying after a dep bump.
    <NativeTabs
      minimizeBehavior="onScrollDown"
      iconColor={{ default: systemColors.secondaryLabel, selected: systemColors.label }}
      labelStyle={{ default: { color: systemColors.secondaryLabel }, selected: { color: systemColors.label } }}
      tintColor={systemColors.label}
    >
      {insideTabs && nativeAccessoryActive && hasCurrentClimb ? (
        <NativeTabs.BottomAccessory key="queue-bottom-accessory">
          <QueueBottomAccessory />
        </NativeTabs.BottomAccessory>
      ) : null}

      <NativeTabs.Trigger name="home">
        <NativeTabs.Trigger.Icon sf="house" md="home" />
        <NativeTabs.Trigger.Label>{t('mobile.nav.home')}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="climbs" role="search">
        <NativeTabs.Trigger.Icon sf="magnifyingglass" md="search" />
        <NativeTabs.Trigger.Label>{t('mobile.nav.climbs')}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="record">
        <NativeTabs.Trigger.Icon sf="record.circle" md="radio_button_checked" />
        <NativeTabs.Trigger.Label>{tSession('mobile.session.recordTab')}</NativeTabs.Trigger.Label>
        {showRecordBadge ? (
          <NativeTabs.Trigger.Badge selectedBackgroundColor={brandColors.success}> </NativeTabs.Trigger.Badge>
        ) : null}
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="discover">
        <NativeTabs.Trigger.Icon sf="bookmark" md="bookmarks" />
        <NativeTabs.Trigger.Label>{tPlaylists('bottomTabBar.discover')}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="profile">
        <NativeTabs.Trigger.Icon sf="person.crop.circle" md="account_circle" />
        <NativeTabs.Trigger.Label>{t('mobile.nav.profile')}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}

const styles = StyleSheet.create({
  // Sidebar + content laid out as a row; the sidebar owns a fixed width and the
  // content pane flexes to fill the rest.
  shell: { flex: 1, flexDirection: 'row' },
  shellContent: { flex: 1 },
  playPane: { borderLeftWidth: StyleSheet.hairlineWidth },
  wallColumn: { borderLeftWidth: StyleSheet.hairlineWidth },
});
