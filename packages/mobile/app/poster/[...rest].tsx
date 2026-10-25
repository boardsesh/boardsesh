import { useEffect, useMemo, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { ActivityIndicator } from '../../src/components/ActivityIndicator';
import { useLaunchHoldReleased } from '../../src/lib/launch-hold';
import { openExternalUrl } from '../../src/lib/open-url';
import { posterPageUrlFromRoute } from '../../src/lib/routing/poster-link';

/** Where the poster link leaves the climber once the browser closes. */
const HOME_TAB = '/(tabs)/home' as const;

/**
 * `/poster/...` — www's print page for a wall poster, which has no screen here.
 *
 * Until a phone refetches the association file that stopped claiming `/poster`,
 * a poster link tapped outside a browser can still open the app, and
 * `+not-found` would drop the climber on Home with nothing to print. This opens
 * the same page in the in-app browser (never `Linking`, which could route it
 * straight back here) and puts Home underneath it.
 */
export default function PosterLinkRoute() {
  const params = useLocalSearchParams();
  const router = useRouter();
  // The browser is a native presentation above the launch update placeholder;
  // a cold-start update could otherwise reload under it (#6006).
  const launchHoldReleased = useLaunchHoldReleased();
  const posterUrl = useMemo(() => posterPageUrlFromRoute(params), [params]);
  const openedUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!launchHoldReleased || openedUrlRef.current === posterUrl) return;
    openedUrlRef.current = posterUrl;
    // Browser first: Android does not reliably present it after a replace has
    // started moving the stack.
    void openExternalUrl(posterUrl, 'poster-link-fallback');
    router.replace(HOME_TAB);
  }, [launchHoldReleased, posterUrl, router]);

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ headerShown: false }} />
      <ActivityIndicator size="large" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
