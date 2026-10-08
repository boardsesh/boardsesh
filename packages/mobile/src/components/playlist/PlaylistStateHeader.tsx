import { useLayoutEffect } from 'react';
import { useNavigation } from 'expo-router';

/**
 * The native header for a playlist screen's loading, error, not-found and
 * choose-a-board states, which never mount `PlaylistDetailView`.
 *
 * HIG Navigation bars: the system back button, not a hand-built chevron, so it
 * keeps the long-press history menu and the edge swipe, and none of these states
 * traps a user on Android, where the edge swipe is off. Opaque, so the state's
 * content lays out below the bar. Every option `PlaylistDetailView` sets is reset
 * here, because a screen moves between these states and the loaded view.
 */
export function PlaylistStateHeader({ title = '' }: { title?: string }): null {
  const navigation = useNavigation();
  useLayoutEffect(() => {
    navigation.setOptions({
      headerShown: true,
      headerTransparent: false,
      headerBlurEffect: undefined,
      headerTitle: undefined,
      headerRight: undefined,
      title,
    });
  }, [navigation, title]);
  return null;
}
