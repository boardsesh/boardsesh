import { useEffect } from 'react';
import { Text, View } from 'react-native';
import { Slot, SplashScreen, usePathname, type ErrorBoundaryProps } from 'expo-router';
import { loadOfflineWriteScreen } from './load';

/** Real SQLite only: no authentication, analytics provider, sync or fixture transport. */
export default function OfflineWriteRoot() {
  const pathname = usePathname();
  useEffect(() => {
    void SplashScreen.hideAsync();
  }, []);
  if (pathname !== '/dev/integration/offline-writes') {
    const Screen = loadOfflineWriteScreen();
    return Screen ? <Screen /> : null;
  }
  return <Slot />;
}

/** Render failures must not initialize the live application's telemetry/services. */
export function OfflineWriteErrorBoundary({ error }: ErrorBoundaryProps) {
  return (
    <View>
      <Text selectable>{`Offline write QA failed: ${error.message}`}</Text>
    </View>
  );
}
