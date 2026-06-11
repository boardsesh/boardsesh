import type { ComponentProps } from 'react';
import { Platform, type ColorValue } from 'react-native';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { Tabs } from 'expo-router';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useTranslation } from 'react-i18next';
import { useBluetoothConnectedStatus } from '../../src/lib/ble/bluetooth-status-store';
import { useHasActiveClimb, useQueueSessionId } from '../../src/providers/queue-provider';
import { QueueBottomAccessory } from '../../src/components/queue-control/QueueBottomAccessory';
import { MaterialTabBar } from '../../src/components/navigation/MaterialTabBar';
import { useTheme } from '../../src/providers/theme-provider';
import { brandColors } from '../../src/theme/colors';
import { useNativeAccessoryActive } from '../../src/hooks/use-bottom-accessory';

// Cold-start on the climbs list (our search surface), not the boards tab — board
// switching is rare, so the filtered climb list is the home base. Drives the
// default-selected tab in both the native-tabs and Material `Tabs` variants.
export const unstable_settings = { initialRouteName: 'climbs' };

type TabIconProps = { focused: boolean; color: ColorValue; size: number };
type MaterialIconName = ComponentProps<typeof MaterialCommunityIcons>['name'];
type RecordBadgeKind = 'session' | 'bluetooth';

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
  const nativeAccessoryActive = useNativeAccessoryActive();

  // Record-tab status cue. A live session is the stronger signal; Bluetooth-only
  // keeps the existing green dot.
  const isBluetoothConnected = useBluetoothConnectedStatus();
  // sessionId-only subscription: the tab layout renders the whole NativeTabs
  // tree inline, so reading the volatile useQueue() here re-rendered every tab
  // on every queue mutation. useQueueSessionId only changes on session start/end.
  const { sessionId } = useQueueSessionId();
  // Presence-only selector (flips just when a climb appears/disappears, not on
  // queue mutations or climb-to-climb nav), so gating the accessory mount on it
  // doesn't re-render the tab tree on every queue change.
  const hasCurrentClimb = useHasActiveClimb();
  const recordBadgeKind: RecordBadgeKind | null =
    sessionId !== null ? 'session' : isBluetoothConnected ? 'bluetooth' : null;
  const recordBadgeColor = recordBadgeKind === 'session' ? brandColors.primaryFill : brandColors.success;
  const eagerMountRecord = Platform.OS === 'android';

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
            tabBarBadge: recordBadgeKind ?? undefined,
            // Android can stall the first lazy mount of this nested stack,
            // leaving the Record tab blank until another tab forces a remount.
            lazy: eagerMountRecord ? false : undefined,
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
      {nativeAccessoryActive && hasCurrentClimb ? (
        <NativeTabs.BottomAccessory>
          <QueueBottomAccessory />
        </NativeTabs.BottomAccessory>
      ) : null}

      <NativeTabs.Trigger name="climbs" role="search">
        <NativeTabs.Trigger.Icon sf="magnifyingglass" md="search" />
        <NativeTabs.Trigger.Label>{t('mobile.nav.climbs')}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="record">
        <NativeTabs.Trigger.Icon sf="record.circle" md="radio_button_checked" />
        <NativeTabs.Trigger.Label>{tSession('mobile.session.recordTab')}</NativeTabs.Trigger.Label>
        {recordBadgeKind ? (
          <NativeTabs.Trigger.Badge selectedBackgroundColor={recordBadgeColor}>
            {recordBadgeKind === 'session' ? '•' : ' '}
          </NativeTabs.Trigger.Badge>
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
