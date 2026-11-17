import type { ReactNode } from 'react';
import { Platform } from 'react-native';
import { Stack, usePathname } from 'expo-router';
import { glassStackScreenOptions } from '../../theme/navigation';
import { useDeviceLayout } from '../../hooks/use-device-layout';
import { useHeaderBlurEffect } from '../../hooks/use-header-blur-effect';

// Subscribe here, below SQLiteProvider's memo boundary. Android reapplies window
// traits from attached underlying screens during transparent-modal rotation, so
// every root scene must agree until fullscreen closes.
export function RootNavigationStack({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { isTablet, foldableInnerDisplay } = useDeviceLayout();
  // Root-level pushed screens (session, about, a climber's profile) inherit the
  // header from here, so they take the same blur gate as every glass stack: none
  // on iOS 26, which draws its own scroll edge effect.
  const headerBlurEffect = useHeaderBlurEffect();
  const orientation =
    pathname === '/spray-led-fullscreen'
      ? 'all'
      : Platform.OS !== 'web' && !isTablet && !foldableInnerDisplay
        ? 'portrait'
        : undefined;
  return (
    <Stack
      screenOptions={{
        ...glassStackScreenOptions,
        headerBlurEffect,
        headerShown: false,
        contentStyle: undefined,
        orientation,
      }}
    >
      {children}
    </Stack>
  );
}
