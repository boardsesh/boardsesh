import { Stack } from 'expo-router';
import { holdUntilLaunchReady } from '../../src/components/launch-update/hold-until-launch-ready';
import { useStackScreenOptions } from '../../src/hooks/use-stack-screen-options';

function AccountLayout() {
  const screenOptions = useStackScreenOptions();
  return (
    <Stack screenOptions={screenOptions}>
      <Stack.Screen name="index" />
      <Stack.Screen name="settings" options={{ headerShown: false }} />
    </Stack>
  );
}

export default holdUntilLaunchReady(AccountLayout);
