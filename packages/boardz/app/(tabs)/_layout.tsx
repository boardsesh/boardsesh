import { Tabs } from 'expo-router';
import { TabBar } from '../../src/ui/TabBar';

/** Home, Session, Workout, Rankings, Profile, under the Graphite tab bar. */
export default function TabsLayout() {
  return (
    <Tabs tabBar={(props) => <TabBar {...props} />} screenOptions={{ headerShown: false }}>
      <Tabs.Screen name="home" />
      <Tabs.Screen name="session" />
      <Tabs.Screen name="workout" />
      <Tabs.Screen name="rankings" />
      <Tabs.Screen name="profile" />
    </Tabs>
  );
}
