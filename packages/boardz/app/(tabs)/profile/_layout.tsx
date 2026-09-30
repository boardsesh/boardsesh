import { Stack } from 'expo-router';

// Screens draw their own headers (PageHeader on the tab's root, TopBar when pushed).
export default function TabStackLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
