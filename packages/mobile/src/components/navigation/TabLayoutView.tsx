import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { Tabs } from 'expo-router';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import type { ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, StyleSheet, View, type ColorValue } from 'react-native';
import { TAB_BADGE_CONNECTED, TAB_BADGE_LIVE } from '../../components/navigation/tab-badge';
import { useTheme } from '../../providers/theme-provider';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { WALL_COLUMN_WIDTH } from '../../theme/size-class';
import { selectByVariant } from '../../theme/variants/select-by-variant';

type TabIconProps = { focused: boolean; color: ColorValue; size: number };
type MaterialIconName = ComponentProps<typeof MaterialCommunityIcons>['name'];

// Material (MaterialCommunityIcons) glyphs for the JS tab bar, mirroring the
// SF Symbols / md hints used by the native tab bar. Rendered on all platforms in
// the Material variant so it reads as Material even on iOS.
const materialTabIcon =
  (active: MaterialIconName, inactive: MaterialIconName) =>
  ({ focused, color, size }: TabIconProps) => (
    <MaterialCommunityIcons
      name={focused ? active : inactive}
      color={color as React.ComponentProps<typeof MaterialCommunityIcons>['color']}
      size={size}
    />
  );

// HIG Tab bars: a selected tab shows the filled variant of its SF Symbol, an
// unselected one the outline. Climbs keeps the plain magnifying glass, like
// Apple Music's Search tab: the symbol has no fill variant. The Android JS bar fills
// its Material icons on focus already (`materialTabIcon`).
const TAB_SF_SYMBOLS = {
  home: { default: 'house', selected: 'house.fill' },
  climbs: 'magnifyingglass',
  record: { default: 'record.circle', selected: 'record.circle.fill' },
  discover: { default: 'bookmark', selected: 'bookmark.fill' },
  profile: { default: 'person.crop.circle', selected: 'person.crop.circle.fill' },
} as const;

// The iPad shell hides the Tabs navigator's own bar (the glass sidebar carries
// navigation), while the navigator still owns routing + per-tab state.
const renderHiddenTabBar = () => null;

// freezeOnBlur only takes effect where inactive screens stay detach-managed
// (iPhone on the Material variant). It's inert where detachInactiveScreens={false} below, because
// react-native-screens' Screen.js gates DelayedFreeze behind `enabled` (the detach
// flag): enabled=false renders a plain display:none View, skipping freeze
// (react-native-screens Screen.js:63,123).
const JS_TABS_SCREEN_OPTIONS = { headerShown: false, freezeOnBlur: true } as const;

export type TabLayoutViewProps = {
  nativeTabBar: boolean;
  deviceLayout: { isTablet: boolean; isPad: boolean; widthClass: string };
  showRecordBadge: boolean;
  hasLiveSession: boolean;
  tabBarMinimizeBehavior: ComponentProps<typeof NativeTabs>['minimizeBehavior'];
  accessoryNativeProps: ComponentProps<typeof NativeTabs>['unstable_nativeProps'];
  prominentClimbsTab: boolean;
  showDetailPane: boolean;
  showWallColumn: boolean;
  wallDisplayOpen: boolean;
  playPaneWidth: number;
  renderTabBar: (props: import('expo-router/tabs').BottomTabBarProps) => React.ReactNode;
  sidebar?: React.ReactNode;
  detailPane?: React.ReactNode;
  wallColumn?: React.ReactNode;
  accessory?: React.ReactNode;
};
export function TabLayoutView({
  nativeTabBar,
  deviceLayout,
  showRecordBadge,
  hasLiveSession,
  tabBarMinimizeBehavior,
  accessoryNativeProps,
  prominentClimbsTab,
  showDetailPane,
  showWallColumn,
  wallDisplayOpen,
  playPaneWidth,
  renderTabBar,
  sidebar,
  detailPane,
  wallColumn,
  accessory,
}: TabLayoutViewProps) {
  const { t } = useTranslation('common');
  const { t: tPlaylists } = useTranslation('playlists');
  const { t: tSession } = useTranslation('session');
  const { systemColors, variant, m3, brandColors } = useTheme();
  const { jsQueueReserve } = useBottomChromeMetrics();
  const paneBottomClearance = Platform.OS === 'web' ? jsQueueReserve : 0;
  const shellDividerColor = selectByVariant(variant, {
    liquidGlass: systemColors.separator,
    material: m3.outlineVariant,
  });
  const eagerMountRecord = Platform.OS === 'android';
  const keepInactiveTabsResident = Platform.OS === 'android';
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
    // Last, so Climbs is the rightmost tab here too, matching the native bar.
    <Tabs.Screen
      key="climbs"
      name="climbs"
      options={{ title: t('mobile.nav.climbs'), tabBarIcon: materialTabIcon('magnify', 'magnify') }}
    />,
  ];

  // Material tablets (Android, Expo web, an iPad on the Material variant) retain
  // the JS rail and pane shell at every width. Native iPad instead keeps one UIKit
  // adaptive sidebar navigator below, with one content column and the current
  // climb in the bottom accessory, like Apple Music.
  if (deviceLayout.isTablet && !nativeTabBar) {
    const isRegular = deviceLayout.widthClass === 'regular';
    const tabsNavigator = (
      <Tabs
        tabBar={isRegular ? renderHiddenTabBar : renderTabBar}
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
        {isRegular ? sidebar : null}
        <View key="content" style={styles.shellContent}>
          {tabsNavigator}
        </View>
        {/* Persistent right column: the PlayDrawer for the SELECTED climb (iPad
            master-detail). Width-budgeted like the wall column (resolveDetailPaneSurface):
            the tightest regular portraits — iPad mini and 9.7–10.2" (744–810pt) — suppress
            it rather than squeeze the browse list below the readable floor; there the
            compact bottom-sheet PlayDrawer takes over (see drawer-host-provider). Not
            mounted under the Wall display, which covers the whole shell — same
            redundancy guard as the wall column below. */}
        {isRegular && showDetailPane && !wallDisplayOpen ? (
          <View
            key="pane"
            testID="desktop-play-pane"
            style={[
              styles.playPane,
              { width: playPaneWidth, borderLeftColor: shellDividerColor, paddingBottom: paneBottomClearance },
            ]}
          >
            {detailPane}
          </View>
        ) : null}
        {/* Dedicated "Now on the wall" column — landscape only, where the width
            budget leaves room for it (see resolveWallSurface). In portrait the wall
            rides a strip atop the pane (IpadPlayPane) instead. Hidden under the
            Wall display — it shows the same feed, so two live copies would be
            redundant. */}
        {isRegular && showWallColumn && !wallDisplayOpen ? (
          <View
            key="wall"
            style={[
              styles.wallColumn,
              { width: WALL_COLUMN_WIDTH, borderLeftColor: shellDividerColor, paddingBottom: paneBottomClearance },
            ]}
          >
            {wallColumn}
          </View>
        ) : null}
      </View>
    );
  }

  if (!nativeTabBar) {
    return (
      <Tabs
        tabBar={renderTabBar}
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
    // lives in patches/react-native-screens@4.30.1.patch, alongside the
    // bottom-accessory relayout fix. `vp run check:mobile-patches` (CI) fails the
    // build if either hunk ever stops applying after a dep bump. Minimizing is an
    // iOS 26 UIKit feature (react-native-screens logs a warning for any other
    // value below 26), so the iOS 18 bar keeps the system default.
    <NativeTabs
      sidebarAdaptable={deviceLayout.isPad}
      minimizeBehavior={tabBarMinimizeBehavior}
      unstable_nativeProps={accessoryNativeProps}
      // UIKit uses tint as the iPad sidebar selection fill. Let it resolve the
      // matching foreground in both sidebar and collapsed-tab placements.
      iconColor={
        deviceLayout.isPad ? undefined : { default: systemColors.secondaryLabel, selected: systemColors.label }
      }
      labelStyle={
        deviceLayout.isPad
          ? undefined
          : { default: { color: systemColors.secondaryLabel }, selected: { color: systemColors.label } }
      }
      tintColor={deviceLayout.isPad ? undefined : systemColors.label}
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
      {accessory != null ? (
        <NativeTabs.BottomAccessory key="queue-bottom-accessory">{accessory}</NativeTabs.BottomAccessory>
      ) : null}

      <NativeTabs.Trigger name="home">
        <NativeTabs.Trigger.Icon sf={TAB_SF_SYMBOLS.home} md="home" />
        <NativeTabs.Trigger.Label>{t('mobile.nav.home')}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="record">
        <NativeTabs.Trigger.Icon sf={TAB_SF_SYMBOLS.record} md="radio_button_checked" />
        <NativeTabs.Trigger.Label>{tSession('mobile.session.recordTab')}</NativeTabs.Trigger.Label>
        {showRecordBadge ? (
          <NativeTabs.Trigger.Badge selectedBackgroundColor={hasLiveSession ? brandColors.live : brandColors.success}>
            {' '}
          </NativeTabs.Trigger.Badge>
        ) : null}
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="discover">
        <NativeTabs.Trigger.Icon sf={TAB_SF_SYMBOLS.discover} md="bookmarks" />
        <NativeTabs.Trigger.Label>{tPlaylists('bottomTabBar.discover')}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="profile">
        <NativeTabs.Trigger.Icon sf={TAB_SF_SYMBOLS.profile} md="account_circle" />
        <NativeTabs.Trigger.Label>{t('mobile.nav.profile')}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      {/* Last, so it is the rightmost tab, like Apple Music's Search tab (HIG Tab
          bars: the search tab sits "at the trailing end"). An ordinary labelled tab,
          not `role="search"`: since SDK 58 that role makes a UISearchTab, which iOS 26
          sets apart from the other tabs and which brings a search field into the bar.
          Climbs has no search field; a second tap on the tab opens Filters instead
          (`useTabReselect` in climbs/index.tsx). `prominent` keeps it on screen at the
          right when the bar collapses on scroll, as Music's Search does. */}
      <NativeTabs.Trigger name="climbs" prominent={prominentClimbsTab}>
        <NativeTabs.Trigger.Icon sf={TAB_SF_SYMBOLS.climbs} md="search" />
        <NativeTabs.Trigger.Label>{t('mobile.nav.climbs')}</NativeTabs.Trigger.Label>
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
