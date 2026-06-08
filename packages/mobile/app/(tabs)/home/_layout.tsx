import { Stack } from 'expo-router';
import { Platform } from 'react-native';

export default function HomeLayout() {
  return (
    <Stack
      screenOptions={{
        headerLargeTitle: false,
        // Solid header on Android; transparent blur is iOS-only (mirrors discover).
        headerTransparent: Platform.OS === 'ios',
        headerBlurEffect: 'systemMaterial',
        contentStyle: { backgroundColor: 'transparent' },
      }}
    >
      <Stack.Screen
        name="index"
        options={{
          // Home owns its in-body large title, so the native header is hidden.
          headerShown: false,
        }}
      />
    </Stack>
  );
}
