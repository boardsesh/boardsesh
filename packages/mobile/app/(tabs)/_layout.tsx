import { useSegments } from 'expo-router';
import { Platform, useWindowDimensions } from 'react-native';
import { IpadWallColumn } from '../../src/components/board-presence/IpadWallColumn';
import { MaterialTabBar } from '../../src/components/navigation/MaterialTabBar';
import { TabLayoutView } from '../../src/components/navigation/TabLayoutView';
import { TabletSidebar } from '../../src/components/navigation/TabletSidebar';
import { IpadPlayPane } from '../../src/components/play-drawer/IpadPlayPane';
import { QueueBottomAccessory } from '../../src/components/queue-control/QueueBottomAccessory';
import { useAccessoryHostRoute } from '../../src/hooks/use-accessory-host-route';
import { useTabChrome } from '../../src/hooks/use-bottom-accessory';
import { useDeviceLayout } from '../../src/hooks/use-device-layout';
import { useStickyAccessoryPresence } from '../../src/hooks/use-sticky-accessory-presence';
import { useVerticalTabBar } from '../../src/hooks/use-vertical-tab-bar';
import { getAppEntryTab } from '../../src/lib/app-entry-route';
import { useBluetoothConnectedStatus } from '../../src/lib/ble/bluetooth-status-store';
import { useActiveBoard } from '../../src/lib/graphql/use-active-board';
import { usePendingBoardSyncPoll } from '../../src/lib/integrations/use-pending-board-sync-poll';
import { isAccessoryHiddenRoute } from '../../src/lib/route-segments';
import { useWallDisplayOpen } from '../../src/lib/wall-display-presence';
import { useBoardPresenceControls } from '../../src/providers/board-presence-provider';
import { useQueueSessionId } from '../../src/providers/queue-provider';
import { SIDEBAR_WIDTH } from '../../src/theme/layout';
import {
  resolveDetailPaneSurface,
  resolveDetailPaneWidth,
  resolveEffectiveWallSurface,
} from '../../src/theme/size-class';

// Select the start-up tab (Climbs unless the climber chose Home) on ordinary
// entry without reordering the native tabs. Read once, at module load, so a
// change in Settings applies from the next start. Explicit routes keep their
// destination; screenshot captures still start at Home.
export const unstable_settings = { initialRouteName: getAppEntryTab() };

// Hoisted so NativeTabs sees a stable prop object; only the route flips between them.
const ACCESSORY_SHOWN_NATIVE_PROPS = { ios: { bottomAccessoryHidden: false } } as const;
const ACCESSORY_HIDDEN_NATIVE_PROPS = { ios: { bottomAccessoryHidden: true } } as const;

/**
 * Bottom tabs. Every iPhone and iPad on the Liquid Glass variant gets the system
 * UIKit tab bar (`expo-router/unstable-native-tabs`), iOS 18 included (HIG, Tab
 * bars: use the system bar so it carries the platform's own materials, Dynamic
 * Type and accessibility); on iPad it adapts to a sidebar. iOS 26 adds the Liquid
 * Glass extras on top: a native `BottomAccessory` platter for the current climb +
 * tick (on iPad too, like Music's MiniPlayer) and minimize-on-scroll.
 * On iOS 18 the bar has neither, so the current climb rides the floating JS
 * `PersistentQueueBar` just above the native bar. Climbs is an ordinary labelled
 * tab everywhere, like Apple Music's Search tab. Material, Android and the
 * tablet shell use a JS `Tabs` navigator with the Material 3 `MaterialTabBar`.
 * `useTabChrome()` is the one answer for all of it.
 */
const renderMaterialTabBar = (props: import('expo-router/tabs').BottomTabBarProps) => <MaterialTabBar {...props} />;
export default function TabLayout() {
  usePendingBoardSyncPoll();
  const { nativeTabBar, liquidGlassTabBar, nativeAccessory: nativeAccessoryActive } = useTabChrome();
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
  // ran `setBottomAccessory:nil` with the bar still up and left the then docked
  // role="search" Climbs item on a stale frame, unhittable until a force-quit (#5055;
  // Climbs is an ordinary tab since #6827, the rule stands). It unmounts only
  // on a root push/modal, where the whole tab VC leaves and the accessory co-detaches
  // with the bar — the case that releases the backing view, so UIKit still never stacks a
  // stale glass platter under the fresh one on return (doubled, offset text). See
  // `isAccessoryHostRoute`. Bottom-chrome arbitration mirrors this surface, so the real
  // mount matches the reserved metrics.
  const onAccessoryHostRoute = useAccessoryHostRoute();
  const hasLiveSession = sessionId !== null;
  const showRecordBadge = isBluetoothConnected || hasLiveSession;
  // Keep blurred tabs' native (Fabric) trees resident on Android so a tab switch is a
  // re-attach, not a createNode/completeRoot rebuild (#3153). Android-only: an iPhone
  // on the Material variant keeping every tab resident would add to the 4GB-device
  // board-art OOM risk (#3479, docs/mobile/react-native-performance.md §7), so it stays on the
  // default + freeze. (NativeTabs keeps visited tabs resident on every iPhone anyway.)
  // A regular-width tablet-sized surface opts into the sidebar shell; compact
  // width (every phone and a narrow tablet/browser window) keeps the native /
  // Material tab bars below verbatim.
  // (deviceLayout.expanded is computed but intentionally unconsumed here — it's
  // reserved for the Phase-3 master+detail Climbs browser; see size-class.ts.)
  const deviceLayout = useDeviceLayout();
  // iOS 27 lets any tab be prominent: it stays visible, at the trailing end, when the
  // bar collapses on scroll (WWDC26 "Modernize your UIKit app"), like Apple Music's
  // Search. The API is iOS 27-only and react-native-screens warns below it. iPhone
  // only: that is where the bar collapses.
  const prominentClimbsTab =
    liquidGlassTabBar && !deviceLayout.isPad && Platform.OS === 'ios' && parseInt(String(Platform.Version), 10) >= 27;
  // On iPhone Duo the bar is a vertical rail, and collapsing it on scroll leaves
  // only Climbs: Home, Record, Discover and Profile disappear until the climber
  // scrolls back up. HIG ("Designing for iPhone Duo"): in navigation-focused
  // screens, keep "the tab bar and primary destinations" accessible. So the rail
  // never minimizes; the horizontal iPhone bar keeps minimize-on-scroll.
  const verticalTabBar = useVerticalTabBar();
  const tabBarMinimizeBehavior = liquidGlassTabBar ? (verticalTabBar ? 'never' : 'onScrollDown') : undefined;
  const { width: windowWidth } = useWindowDimensions();
  const segments = useSegments();
  // The wall-redundancy rule below: while the full-screen Wall display covers the
  // shell, the shell's own wall column and player pane stand down, so the same
  // feed isn't rendered twice behind an opaque kiosk. Read from the root stack,
  // not the focused segments, so a page pushed over the kiosk does not remount
  // them behind it.
  const wallDisplayOpen = useWallDisplayOpen();
  // The hold-type and zone filter boards keep their controls at the bottom of the
  // screen, right where the accessory platter draws. Hide the platter there through
  // the native `bottomAccessoryHidden` prop instead of unmounting the host (#5055);
  // see `isAccessoryHiddenRoute`. Not while the tab bar is a vertical rail (iPhone
  // Duo, closed or open in landscape): hiding the accessory then collapses the
  // rail to the Climbs tab. There it stays, spanning the bottom of the content
  // like Music's mini player, and those filter boards clear it through the tab's
  // own inset instead (HoldFilterPicker; the zone footer already does). The iPad
  // "On the Wall" kiosk hides it too: its hero already shows the lit climb. The
  // bottom-chrome metrics mirror this expression so nothing is reserved for it.
  const accessoryNativeProps =
    nativeAccessoryActive && isAccessoryHiddenRoute(segments) && !verticalTabBar
      ? ACCESSORY_HIDDEN_NATIVE_PROPS
      : ACCESSORY_SHOWN_NATIVE_PROPS;
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
  // BoardSheet and its Wall display. Only the 11" Pro and 13" tablets keep the
  // persistent panel.
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

  return (
    <TabLayoutView
      nativeTabBar={nativeTabBar}
      deviceLayout={deviceLayout}
      showRecordBadge={showRecordBadge}
      hasLiveSession={hasLiveSession}
      tabBarMinimizeBehavior={tabBarMinimizeBehavior}
      accessoryNativeProps={accessoryNativeProps}
      prominentClimbsTab={prominentClimbsTab}
      showDetailPane={showDetailPane}
      showWallColumn={showWallColumn}
      wallDisplayOpen={wallDisplayOpen}
      playPaneWidth={playPaneWidth}
      renderTabBar={renderMaterialTabBar}
      sidebar={<TabletSidebar showWallCell={!showRichWallSurface} />}
      detailPane={<IpadPlayPane />}
      wallColumn={<IpadWallColumn />}
      accessory={onAccessoryHostRoute && nativeAccessoryActive && hasCurrentClimb ? <QueueBottomAccessory /> : null}
    />
  );
}
