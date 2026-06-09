import type { ComponentProps } from 'react';
import type { ColorValue } from 'react-native';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { Tabs } from 'expo-router';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useTranslation } from 'react-i18next';
import { useBluetoothConnectedStatus } from '../../src/lib/ble/bluetooth-status-store';
import { useQueueSessionId } from '../../src/providers/queue-provider';
import { QueueBottomAccessory } from '../../src/components/queue-control/QueueBottomAccessory';
import { MaterialTabBar } from '../../src/components/navigation/MaterialTabBar';
import { useTheme } from '../../src/providers/theme-provider';
import { brandColors } from '../../src/theme/colors';

// Cold-start on the climbs list (our search surface), not the boards tab — board
// switching is rare, so the filtered climb list is the home base. Drives the
// default-selected tab in both the native-tabs and Material `Tabs` variants.
export const unstable_settings = { initialRouteName: 'climbs' };

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

/**
 * Bottom tabs. The Liquid Glass variant uses the system Liquid Glass tab bar
 * (`expo-router/unstable-native-tabs`) with a native `BottomAccessory` platter
 * for the current climb + tick. The Material variant uses a JS `Tabs` navigator
 * with the Material 3 `MaterialTabBar`; its climb/tick chrome rides the floating
 * `PersistentQueueBar` (the native accessory is Liquid-Glass-only).
 */
export default function TabLayout() {
  const { t } = useTranslation('common');
  const { t: tPlaylists } = useTranslation('playlists');
  const { t: tSession } = useTranslation('session');
  const { variant } = useTheme();

  // Record-tab status cue: a badge when a board is connected over Bluetooth or a
  // session is live.
  const isBluetoothConnected = useBluetoothConnectedStatus();
  // sessionId-only subscription: the tab layout renders the whole NativeTabs
  // tree inline, so reading the volatile useQueue() here re-rendered every tab
  // on every queue mutation. useQueueSessionId only changes on session start/end.
  const { sessionId } = useQueueSessionId();
  const showRecordBadge = isBluetoothConnected || sessionId !== null;

  if (variant === 'material') {
    return (
      <Tabs tabBar={(props) => <MaterialTabBar {...props} />} screenOptions={{ headerShown: false }}>
        <Tabs.Screen
          name="climbs"
          options={{ title: t('mobile.nav.climbs'), tabBarIcon: materialTabIcon('magnify', 'magnify') }}
        />
        <Tabs.Screen
          name="record"
          options={{
            title: tSession('mobile.session.recordTab'),
            tabBarIcon: materialTabIcon('record-circle', 'record-circle-outline'),
            tabBarBadge: showRecordBadge ? '' : undefined,
          }}
        />
        <Tabs.Screen
          name="discover"
          options={{
            title: tPlaylists('bottomTabBar.discover'),
            tabBarIcon: materialTabIcon('bookmark-multiple', 'bookmark-multiple-outline'),
          }}
        />
        <Tabs.Screen
          name="profile"
          options={{
            title: t('mobile.nav.profile'),
            tabBarIcon: materialTabIcon('account-circle', 'account-circle-outline'),
          }}
        />
      </Tabs>
    );
  }

  return (
    // `minimizeBehavior="onScrollDown"` relies on UIKit finding the climbs
    // FlashList's nested scroll view, which it can't by default — that fallback
    // lives in patches/react-native-screens@4.25.2.patch. `vp run check:mobile-patches`
    // (CI) fails the build if that patch ever stops applying after a dep bump.
    <NativeTabs minimizeBehavior="onScrollDown">
      <NativeTabs.BottomAccessory>
        <QueueBottomAccessory />
      </NativeTabs.BottomAccessory>

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
