import type { ReactNode } from 'react';
import { Platform } from 'react-native';
import { Stack, usePathname } from 'expo-router';
import { glassStackScreenOptions } from '../../theme/navigation';
import { useDeviceLayout } from '../../hooks/use-device-layout';

// Subscribe here, below SQLiteProvider's memo boundary. Android reapplies window
// traits from attached underlying screens during transparent-modal rotation, so
// every root scene must agree until fullscreen closes.
export function RootNavigationStack({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { isTablet, foldableInnerDisplay } = useDeviceLayout();
  const isSprayFullscreen = pathname === '/spray-led-fullscreen';
  const orientation = isSprayFullscreen
    ? 'all'
    : Platform.OS !== 'web' && !isTablet && !foldableInnerDisplay
      ? 'portrait'
      : undefined;
  return (
    <Stack
      screenOptions={{
        ...glassStackScreenOptions,
        headerShown: false,
        contentStyle: undefined,
        orientation,
        // Attached Android screens reapply these traits during a window update.
        ...(Platform.OS === 'android'
          ? { statusBarHidden: isSprayFullscreen, navigationBarHidden: isSprayFullscreen }
          : {}),
      }}
    >
      {children}
    </Stack>
  );
}
