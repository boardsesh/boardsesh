import { Stack } from 'expo-router';
import { useStackScreenOptions } from '../../src/hooks/use-stack-screen-options';

export default function AuthLayout() {
  const screenOptions = useStackScreenOptions();
  return (
    <Stack screenOptions={{ ...screenOptions, headerShown: false }}>
      <Stack.Screen name="login" />
      {/* register, forgot-password, and reset-password set their own header via Stack.Screen. */}
      <Stack.Screen name="register" />
      <Stack.Screen name="forgot-password" />
      <Stack.Screen name="reset-password" />
    </Stack>
  );
}
