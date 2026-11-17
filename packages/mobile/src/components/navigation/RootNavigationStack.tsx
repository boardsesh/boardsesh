import { useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { Platform } from 'react-native';
import { Stack, useGlobalSearchParams, usePathname } from 'expo-router';
import { glassStackScreenOptions } from '../../theme/navigation';
import { useDeviceLayout } from '../../hooks/use-device-layout';
import { readSprayPhotoSession, subscribeSprayPhotoSession } from '../../lib/spray/spray-photo-session';

// Subscribe here, below SQLiteProvider's memo boundary. Android reapplies window
// traits from attached underlying screens during transparent-modal rotation, so
// every root scene must agree until fullscreen closes.
export function RootNavigationStack({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { photoSessionId } = useGlobalSearchParams<{ photoSessionId?: string }>();
  const { isTablet, foldableInnerDisplay } = useDeviceLayout();
  const isSprayFullscreen = pathname === '/spray-led-fullscreen';
  const lockedOrientation = useSyncExternalStore(
    subscribeSprayPhotoSession,
    () => {
      if (!isSprayFullscreen || typeof photoSessionId !== 'string') return null;
      const session = readSprayPhotoSession(photoSessionId);
      if (!session?.lockOrientationToWall) return null;
      const { width, height } = session.canvas.source.frame;
      return width > height ? ('landscape_right' as const) : ('portrait_up' as const);
    },
    () => null,
  );
  const closingLock = useRef<{ id: string; orientation: NonNullable<typeof lockedOrientation> } | null>(null);
  useLayoutEffect(() => {
    // The leave guard revokes the photo session before the router finishes popping.
    // Keep the same orientation through that interval.
    if (lockedOrientation && photoSessionId)
      closingLock.current = { id: photoSessionId, orientation: lockedOrientation };
    else if (!isSprayFullscreen) closingLock.current = null;
  }, [isSprayFullscreen, lockedOrientation, photoSessionId]);
  const retainedOrientation = closingLock.current?.id === photoSessionId ? closingLock.current?.orientation : null;
  const orientation = isSprayFullscreen
    ? (lockedOrientation ?? retainedOrientation ?? 'all')
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
