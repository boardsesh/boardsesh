import { View, Text, Pressable, StyleSheet, Platform, useColorScheme } from 'react-native';
import { BlurView } from '@react-native-community/blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import type { BottomTabBarProps } from 'expo-router/build/react-navigation/bottom-tabs';
import { iosSystemColors, iosDarkColors, iosLightColors } from '../theme/ios-colors';
import { useBluetoothConnectedStatus } from '../lib/ble/bluetooth-status-store';
import { brandColors } from '../theme/colors';

const TAB_BAR_HEIGHT = 49;

type TabIconName = 'view-dashboard' | 'magnify' | 'playlist-play' | 'account' | 'dots-horizontal';

const TAB_ICONS: Record<string, TabIconName> = {
  boards: 'view-dashboard',
  climbs: 'magnify',
  queue: 'playlist-play',
  profile: 'account',
  more: 'dots-horizontal',
};

// Placeholder badge count for the queue tab
const QUEUE_BADGE_COUNT = 0;

export default function BlurTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const isBluetoothConnected = useBluetoothConnectedStatus();

  const activeTint = iosSystemColors.systemBlue;
  const inactiveTint = isDark ? iosDarkColors.systemGray : iosLightColors.inactiveGray;
  const totalHeight = TAB_BAR_HEIGHT + insets.bottom;

  const renderContent = () => (
    <View style={[styles.tabRow, { height: TAB_BAR_HEIGHT }]}>
      {state.routes.map((route, index) => {
        const { options } = descriptors[route.key];
        const label = options.title ?? route.name;
        const isFocused = state.index === index;
        const tintColor = isFocused ? activeTint : inactiveTint;
        const iconName = TAB_ICONS[route.name] ?? 'dots-horizontal';
        const showBadge = route.name === 'queue' && QUEUE_BADGE_COUNT > 0;
        const showBluetoothDot = route.name === 'queue' && isBluetoothConnected;

        const onPress = () => {
          const event = navigation.emit({
            type: 'tabPress',
            target: route.key,
            canPreventDefault: true,
          });

          if (!isFocused && !event.defaultPrevented) {
            navigation.navigate(route.name, route.params);
          }
        };

        const onLongPress = () => {
          navigation.emit({
            type: 'tabLongPress',
            target: route.key,
          });
        };

        return (
          <Pressable
            key={route.key}
            accessibilityRole="button"
            accessibilityState={isFocused ? { selected: true } : undefined}
            accessibilityLabel={options.tabBarAccessibilityLabel}
            onPress={onPress}
            onLongPress={onLongPress}
            style={styles.tabItem}
          >
            <View style={styles.iconContainer}>
              <MaterialCommunityIcons name={iconName} size={24} color={tintColor} />
              {showBadge && (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{QUEUE_BADGE_COUNT}</Text>
                </View>
              )}
              {showBluetoothDot && <View style={styles.bluetoothDot} />}
            </View>
            <Text style={[styles.label, { color: tintColor }]} numberOfLines={1}>
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );

  if (Platform.OS === 'ios') {
    return (
      <View style={[styles.container, { height: totalHeight, paddingBottom: insets.bottom }]}>
        <BlurView
          blurType={isDark ? 'dark' : 'light'}
          blurAmount={20}
          reducedTransparencyFallbackColor={
            isDark ? iosDarkColors.secondaryBackground : iosLightColors.secondaryBackground
          }
          style={StyleSheet.absoluteFill}
        />
        <View
          style={[styles.separator, { backgroundColor: isDark ? iosDarkColors.separator : iosLightColors.separator }]}
        />
        {renderContent()}
      </View>
    );
  }

  // Android fallback: semi-transparent background
  return (
    <View
      style={[
        styles.container,
        {
          height: totalHeight,
          paddingBottom: insets.bottom,
          backgroundColor: isDark
            ? `${iosDarkColors.secondaryBackground}F2`
            : `${iosLightColors.secondaryBackground}F2`,
        },
      ]}
    >
      <View
        style={[styles.separator, { backgroundColor: isDark ? iosDarkColors.separator : iosLightColors.separator }]}
      />
      {renderContent()}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
  },
  tabRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 6,
  },
  iconContainer: {
    position: 'relative',
  },
  badge: {
    position: 'absolute',
    top: -4,
    right: -10,
    backgroundColor: iosSystemColors.systemRed,
    borderRadius: 9,
    minWidth: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  badgeText: {
    color: iosSystemColors.white,
    fontSize: 11,
    fontWeight: '600',
  },
  bluetoothDot: {
    position: 'absolute',
    top: -2,
    right: -4,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: brandColors.success,
  },
  label: {
    fontSize: 10,
    marginTop: 2,
  },
});
