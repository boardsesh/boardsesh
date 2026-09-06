import type { ComponentProps } from 'react';
import { Platform, StyleSheet, View, useWindowDimensions, type ColorValue } from 'react-native';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { Tabs, useSegments } from 'expo-router';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useTranslation } from 'react-i18next';
import { useBluetoothConnectedStatus } from '../../src/lib/ble/bluetooth-status-store';
import { useQueueSessionId } from '../../src/providers/queue-provider';
import { useStickyAccessoryPresence } from '../../src/hooks/use-sticky-accessory-presence';
import { QueueBottomAccessory } from '../../src/components/queue-control/QueueBottomAccessory';
import { MaterialTabBar } from '../../src/components/navigation/MaterialTabBar';
import { TAB_BADGE_CONNECTED, TAB_BADGE_LIVE } from '../../src/components/navigation/tab-badge';
import { useTheme } from '../../src/providers/theme-provider';
import { selectByVariant } from '../../src/theme/variants/select-by-variant';
import { useNativeAccessoryActive, useNativeTabBar } from '../../src/hooks/use-bottom-accessory';
import { useAccessoryHostRoute } from '../../src/hooks/use-accessory-host-route';
import { useDeviceLayout } from '../../src/hooks/use-device-layout';
import { TabletSidebar } from '../../src/components/navigation/TabletSidebar';
import { IpadPlayPane } from '../../src/components/play-drawer/IpadPlayPane';
import { IpadWallColumn } from '../../src/components/board-presence/IpadWallColumn';
import { useBoardPresenceControls } from '../../src/providers/board-presence-provider';
import { useActiveBoard } from '../../src/lib/graphql/use-active-board';
import {
  resolveEffectiveWallSurface,
  resolveDetailPaneSurface,
  resolveDetailPaneWidth,
  WALL_COLUMN_WIDTH,
} from '../../src/theme/size-class';
import { tabsActiveSegment } from '../../src/lib/route-segments';
import { useKeepAwakeWhile } from '../../src/hooks/use-keep-awake-while';
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

// freezeOnBlur only takes effect where inactive screens stay detach-managed
// (iOS < 26 iPhone). It's inert where detachInactiveScreens={false} below, because
// react-native-screens' Screen.js gates DelayedFreeze behind `enabled` (the detach
// flag): enabled=false renders a plain display:none View, skipping freeze
// (react-native-screens Screen.js:63,123).
const JS_TABS_SCREEN_OPTIONS = { headerShown: false, freezeOnBlur: true } as const;

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
  const { systemColors, variant, m3, brandColors } = useTheme();
  const nativeTabBar = useNativeTabBar();
  // Shell column separators: an M3 faint divider (outlineVariant) on Material, the
  // system hairline on Liquid Glass — so the panes read as M3 depth on Android.
  const shellDividerColor = selectByVariant(variant, {
    liquidGlass: systemColors.separator,
    material: m3.outlineVariant,
  });
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
  // Route term on the same mount gate: the host stays mounted anywhere the tab bar is
  // on screen — every route inside the tabs group, pushed sub-routes included, plus the
  // transparent player. The accessory is a CHILD of the bar, so unmounting it on a push
  // ran `setBottomAccessory:nil` with the bar still up and left the docked role="search"
  // Climbs item on a stale frame, unhittable until a force-quit (#5055). It unmounts only
  // on a root push/modal, where the whole tab VC leaves and the accessory co-detaches
  // with the bar — the case that releases the backing view, so UIKit still never stacks a
  // stale glass platter under the fresh one on return (doubled, offset text). See
  // `isAccessoryHostRoute`. Bottom-chrome arbitration mirrors this surface, so the real
  // mount matches the reserved metrics.
  const onAccessoryHostRoute = useAccessoryHostRoute();
  const hasLiveSession = sessionId !== null;
  const showRecordBadge = isBluetoothConnected || hasLiveSession;
  const eagerMountRecord = Platform.OS === 'android';
  // Keep blurred tabs' native (Fabric) trees resident on Android so a tab switch is a
  // re-attach, not a createNode/completeRoot rebuild (#3153). Android-only: on iOS < 26
  // iPhones keeping every tab resident would add to the 4GB-device board-art OOM risk
  // (#3479, docs/react-native-performance.md §7), so those stay on the default + freeze.
  const keepInactiveTabsResident = Platform.OS === 'android';
  // A regular-width tablet-sized surface opts into the sidebar shell; compact
  // width (every phone and a narrow tablet/browser window) keeps the native /
  // Material tab bars below verbatim.
  // (deviceLayout.expanded is computed but intentionally unconsumed here — it's
  // reserved for the Phase-3 master+detail Climbs browser; see size-class.ts.)
  const deviceLayout = useDeviceLayout();
  const { width: windowWidth } = useWindowDimensions();
  // The focused tab drives the wall-redundancy rule below: when the "On the
  // Wall" destination is open, the ambient column is suppressed so the same feed
  // isn't shown twice. `tabsActiveSegment` reads segment 1 without indexing the
  // route-typed tuple (see route-segments.ts).
  const segments = useSegments();
  const onWallTab = tabsActiveSegment(segments) === 'wall';
  // Kiosk stays lit: hold the screen awake while the "On the Wall" tab is the
  // focused destination (iPad-only — /wall is unreachable elsewhere). Released
  // on navigate-away and unmount so other tabs don't hold the lock.
  useKeepAwakeWhile(onWallTab, 'wall');
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
  // Below the device-size floor (iPad mini / base 11" / Air 11" — see
  // WALL_PANEL_MIN_DEVICE_LONG_SIDE) `resolveEffectiveWallSurface` collapses the
  // column AND the strip to `none`; those devices reach the wall through the
  // BoardSheet peek and the "On the Wall" tab, like the phone. Only the 11" Pro
  // and 13" iPads keep the persistent panel.
  const wallSurface = resolveEffectiveWallSurface({
    width: windowWidth,
    widthClass: deviceLayout.widthClass,
    wallDeviceClass: deviceLayout.wallDeviceClass,
    sidebarWidth: SIDEBAR_WIDTH,
  });
  const showWallColumn =
    wallSurface === 'column' && boardPresenceEnabled && boardPresenceBoardId !== null && activeBoard != null;
  // The detail (play) pane scales with the window (clamped 320–400pt) when it is
  // the only trailing pane. When the wall column is visible, the wall keeps its
  // fixed width and the content + detail columns split the remaining space evenly.
  const playPaneWidth = resolveDetailPaneWidth({
    width: windowWidth,
    sidebarWidth: SIDEBAR_WIDTH,
    wallColumnVisible: showWallColumn,
  });
  // The detail (play) pane is width-budgeted exactly like the wall column: it only
  // mounts when the browse list still clears the readable floor after the sidebar
  // and a minimum pane width. On the tightest regular portraits (iPad mini /
  // 9.7–10.2", 744–810pt) it's suppressed and the compact bottom-sheet PlayDrawer
  // hosts the drawer instead (see drawer-host-provider), so the list keeps room.
  const showDetailPane =
    resolveDetailPaneSurface({
      width: windowWidth,
      widthClass: deviceLayout.widthClass,
      sidebarWidth: SIDEBAR_WIDTH,
    }) === 'pane';
  const showWallStrip =
    showDetailPane &&
    wallSurface === 'strip' &&
    boardPresenceEnabled &&
    boardPresenceBoardId !== null &&
    activeBoard != null;
  const showRichWallSurface = showWallColumn || showWallStrip;

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
        // State marker, not display text — MaterialTabBar's badge is a color dot
        // with no text and branches its dot color on this value. Both ends of that
        // contract go through src/components/navigation/tab-badge.
        tabBarBadge: showRecordBadge ? (hasLiveSession ? TAB_BADGE_LIVE : TAB_BADGE_CONNECTED) : undefined,
        // Android can stall the first lazy mount of this nested stack,
        // leaving the Record tab blank until another tab forces a remount.
        lazy: eagerMountRecord ? false : undefined,
      }}
    />,
    <Tabs.Screen
      key="wall"
      name="wall"
      // iPad-only "On the Wall" destination. `href: null` hides it from the JS
      // Material tab bar (expo-router turns it into tabBarItemStyle:{display:'none'},
      // which MaterialTabBar filters) and there's no NativeTabs.Trigger below, so it
      // never appears as a 6th bottom tab on any phone. It's registered here anyway
      // so the single JS Tabs navigator can route /wall INSIDE the shell content
      // (keeping the sidebar + panes), reached from the iPad sidebar rail row; a root
      // route would cover the shell instead.
      options={{ href: null, title: t('mobile.nav.wall') }}
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

  // Large-screen adaptive shell. ONE JS `Tabs` navigator is mounted across the
  // regular↔compact boundary, so resizing an iPad window across the breakpoint (a
  // Split View drag, a Stage Manager resize) swaps only the CHROME — the glass
  // sidebar + content panes at regular width, the Material tab bar in a narrow
  // split — and keeps each tab's scroll offset and nested-stack depth instead of
  // remounting the navigator. Web follows this path with Material chrome. The
  // navigator still owns routing; at regular width
  // its bar is hidden and the sidebar drives it through the global router. iPad
  // never uses NativeTabs (that would swap navigator *types* on the boundary cross
  // and remount); NativeTabs stays the iPhone-only glass path below. The `content`
  // View carries a stable key so the navigator survives the chrome swap.
  if (deviceLayout.isTablet) {
    const isRegular = deviceLayout.widthClass === 'regular';
    const tabsNavigator = (
      <Tabs
        tabBar={isRegular ? renderHiddenTabBar : (props) => <MaterialTabBar {...props} />}
        screenOptions={JS_TABS_SCREEN_OPTIONS}
        // iPads have the RAM headroom, and the sidebar shell hits the same
        // detach-and-rebuild cost on every destination change (#3153).
        detachInactiveScreens={false}
      >
        {tabScreens}
      </Tabs>
    );
    return (
      <View style={isRegular ? styles.shell : styles.shellCompact}>
        {isRegular ? <TabletSidebar key="sidebar" showWallCell={!showRichWallSurface} /> : null}
        <View key="content" style={styles.shellContent}>
          {tabsNavigator}
        </View>
        {/* Persistent right column: the PlayDrawer for the SELECTED climb (iPad
            master-detail). Width-budgeted like the wall column (resolveDetailPaneSurface):
            the tightest regular portraits — iPad mini and 9.7–10.2" (744–810pt) — suppress
            it rather than squeeze the browse list below the readable floor; there the
            compact bottom-sheet PlayDrawer takes over (see drawer-host-provider). Hidden
            on the "On the Wall" tab: the kiosk IS the wall surface and needs the full
            content pane, so a persistent (usually empty) detail pane there just squeezes
            it — same redundancy guard as the wall column below. */}
        {isRegular && showDetailPane && !onWallTab ? (
          <View key="pane" style={[styles.playPane, { width: playPaneWidth, borderLeftColor: shellDividerColor }]}>
            <IpadPlayPane />
          </View>
        ) : null}
        {/* Dedicated "Now on the wall" column — landscape only, where the width
            budget leaves room for it (see resolveWallSurface). In portrait the wall
            rides a strip atop the pane (IpadPlayPane) instead. Hidden while the
            "On the Wall" tab is the focused destination — it shows the same feed,
            so two live copies would be redundant. */}
        {isRegular && showWallColumn && !onWallTab ? (
          <View
            key="wall"
            style={[styles.wallColumn, { width: WALL_COLUMN_WIDTH, borderLeftColor: shellDividerColor }]}
          >
            <IpadWallColumn />
          </View>
        ) : null}
      </View>
    );
  }

  if (!nativeTabBar) {
    return (
      <Tabs
        tabBar={(props) => <MaterialTabBar {...props} />}
        screenOptions={JS_TABS_SCREEN_OPTIONS}
        detachInactiveScreens={keepInactiveTabsResident ? false : undefined}
      >
        {tabScreens}
      </Tabs>
    );
  }

  return (
    // `minimizeBehavior="onScrollDown"` relies on UIKit finding the climbs
    // FlashList's nested scroll view, which it can't by default — that fallback
    // lives in patches/react-native-screens@4.26.2.patch, alongside the
    // bottom-accessory relayout fix. `vp run check:mobile-patches` (CI) fails the
    // build if either hunk ever stops applying after a dep bump.
    <NativeTabs
      minimizeBehavior="onScrollDown"
      iconColor={{ default: systemColors.secondaryLabel, selected: systemColors.label }}
      labelStyle={{ default: { color: systemColors.secondaryLabel }, selected: { color: systemColors.label } }}
      tintColor={systemColors.label}
      // `NativeTabs.Trigger.Badge`'s `selectedBackgroundColor` only reaches
      // `options.selectedBadgeBackgroundColor`, which react-navigation-native-tabs
      // applies solely to the ['selected','focused'] item states
      // (appearance.ios.js `appendSelectedStyleToAppearance`). The Record badge is
      // most useful precisely when Record ISN'T focused (a session is live while
      // the user browses another tab), so the normal-state tint must come from the
      // navigator-level `badgeBackgroundColor` prop, which seeds
      // `options.badgeBackgroundColor` — applied to normal/focused/selected alike
      // (appearance.ios.js `createStandardAppearanceFromOptions`).
      //
      // CAUTION: this is a navigator-wide DEFAULT — it tints every
      // `NativeTabs.Trigger.Badge` here, not just Record's. It's only correct
      // because Record owns the sole badge (locked by the "keeps Record as the
      // only badged trigger" test in __tests__/tab-layout.test.tsx). If another
      // tab ever gains a badge, drop this prop and move the session color onto
      // per-trigger styling instead of letting the new badge inherit it.
      badgeBackgroundColor={hasLiveSession ? brandColors.live : brandColors.success}
    >
      {onAccessoryHostRoute && nativeAccessoryActive && hasCurrentClimb ? (
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
          <NativeTabs.Trigger.Badge selectedBackgroundColor={hasLiveSession ? brandColors.live : brandColors.success}>
            {' '}
          </NativeTabs.Trigger.Badge>
        ) : null}
      </NativeTabs.Trigger>

      {/* /wall is a (tabs) route (the iPad sidebar routes to it), so it must be
          declared to NativeTabs — but `hidden` keeps it off the iPhone glass bar,
          where a 6th tab would spill into "More" and clash with the search slot. */}
      <NativeTabs.Trigger name="wall" hidden />

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
  // iPad in a narrow split (compact): the same single `Tabs` navigator, no rail,
  // just filling the window — so the navigator stays mounted across the boundary.
  shellCompact: { flex: 1 },
  shellContent: { flex: 1 },
  playPane: { borderLeftWidth: StyleSheet.hairlineWidth },
  wallColumn: { borderLeftWidth: StyleSheet.hairlineWidth },
});
