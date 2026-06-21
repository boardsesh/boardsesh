import { Stack } from 'expo-router';
import { useStackScreenOptions } from '../../../src/hooks/use-stack-screen-options';

export default function HomeLayout() {
  const screenOptions = useStackScreenOptions();
  return (
    <Stack screenOptions={screenOptions}>
      {/* The Home feed owns its top via floating chrome (the avatar island + scope
          title), like the other tabs — so the stack header is hidden here. */}
      <Stack.Screen name="index" options={{ headerShown: false }} />
      {/* Session detail keeps the native tab bar + bottom accessory by living in
          this stack. It sets its own header title from the loaded session. */}
      <Stack.Screen name="session/[sessionId]" options={{ headerShown: true }} />
    </Stack>
  );
}
