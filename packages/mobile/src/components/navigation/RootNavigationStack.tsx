import type { ReactNode } from 'react';
import { Dimensions, Platform } from 'react-native';
import { Stack, usePathname } from 'expo-router';
import { glassStackScreenOptions } from '../../theme/navigation';
import { resolveIsTablet } from '../../theme/size-class';

// Subscribe here, below SQLiteProvider's memo boundary. Android reapplies window
// traits from attached underlying screens during transparent-modal rotation, so
// every root scene must agree until fullscreen closes.
export function RootNavigationStack({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const screen = Dimensions.get('screen');
  const isTablet = resolveIsTablet({
    platformOS: Platform.OS,
    isPad: Platform.OS === 'ios' && Platform.isPad === true,
    screenShortSide: Math.min(screen.width, screen.height),
  });
  const orientation =
    pathname === '/spray-led-fullscreen' ? 'all' : Platform.OS !== 'web' && !isTablet ? 'portrait' : undefined;
  return (
    <Stack screenOptions={{ ...glassStackScreenOptions, headerShown: false, contentStyle: undefined, orientation }}>
      {children}
    </Stack>
  );
}
