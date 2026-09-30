import type { ComponentProps } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import type { Tabs } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FONT } from './fonts';
import { Icon, type IconComponent } from './Icon';
import { Dumbbell, House, LayoutGrid, Trophy, User } from './icons';
import { Text } from './Text';
import { useTheme } from './theme';

type TabBarRenderer = NonNullable<ComponentProps<typeof Tabs>['tabBar']>;
export type TabBarProps = Parameters<TabBarRenderer>[0];

const TABS: Record<string, { label: string; icon: IconComponent }> = {
  home: { label: 'Home', icon: House },
  session: { label: 'Session', icon: LayoutGrid },
  workout: { label: 'Workout', icon: Dumbbell },
  rankings: { label: 'Rankings', icon: Trophy },
  profile: { label: 'Profile', icon: User },
};

/** The bottom bar: a hairline on top, the active tab in ink with a short bar above it. */
export function TabBar({ state, navigation }: TabBarProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      accessibilityRole="tablist"
      style={[
        styles.bar,
        // The home indicator needs less than the full inset below the labels.
        { backgroundColor: theme.bgApp, borderTopColor: theme.border2, paddingBottom: Math.max(insets.bottom - 14, 6) },
      ]}
    >
      {state.routes.map((route, index) => {
        const tab = TABS[route.name];
        if (!tab) return null;
        const focused = state.index === index;
        const color = focused ? theme.fg1 : theme.fg3;
        return (
          <Pressable
            key={route.key}
            accessibilityRole="tab"
            accessibilityLabel={tab.label}
            accessibilityState={{ selected: focused }}
            onPress={() => {
              const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
              if (!focused && !event.defaultPrevented) {
                void Haptics.selectionAsync();
                navigation.navigate(route.name, route.params);
              }
            }}
            style={styles.item}
          >
            <View style={[styles.signal, { backgroundColor: focused ? theme.fg1 : 'transparent' }]} />
            <Icon icon={tab.icon} size={22} color={color} strokeWidth={focused ? 2.1 : 1.75} />
            <Text
              variant="caption"
              color={color}
              style={{ fontSize: 10, lineHeight: 12, fontFamily: focused ? FONT.sansSemiBold : FONT.sansMedium }}
            >
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', borderTopWidth: 1, paddingHorizontal: 4 },
  item: { flex: 1, height: 56, alignItems: 'center', justifyContent: 'center', gap: 5 },
  signal: { position: 'absolute', top: -1, width: 20, height: 2, borderRadius: 1 },
});
