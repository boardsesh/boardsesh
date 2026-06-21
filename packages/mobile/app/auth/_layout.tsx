import { Stack } from 'expo-router';
import { useStackScreenOptions } from '../../src/hooks/use-stack-screen-options';

export default function AuthLayout() {
  const screenOptions = useStackScreenOptions();
  return (
    <Stack screenOptions={{ ...screenOptions, headerShown: false }}>
      <Stack.Screen name="login" />
      {/* register.tsx sets its own header (title + back chevron) via Stack.Screen. */}
      <Stack.Screen name="register" />
    </Stack>
  );
}
