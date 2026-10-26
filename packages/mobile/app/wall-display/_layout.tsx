import { useMemo } from 'react';
import { Stack } from 'expo-router';
import { holdUntilLaunchReady } from '../../src/components/launch-update/hold-until-launch-ready';
import { useStackScreenOptions } from '../../src/hooks/use-stack-screen-options';
import { useTheme } from '../../src/providers/theme-provider';

/**
 * The Wall display: the full-screen kiosk for an iPad mounted at the board. A
 * root `transparentModal` (app/_layout.tsx) that covers the sidebar, the tab bar
 * and the bottom accessory. It replaced the iPad-only "On the Wall" tab.
 *
 * Its own Stack keeps Settings and climber profiles opened from here inside the
 * modal (`scoped-navigation.ts` scopes `/settings` and `/users/...` to it), the
 * way each tab keeps its own copies.
 *
 * No `BoardArtVisibilityProvider`: that one hides board art in an iPad tab that
 * is not focused, and this route is not a tab. While it is up, the tabs behind
 * it report hidden and release their board art.
 *
 * Held until launch is ready: the old `wall` link can open it on a cold start,
 * while the launch update gate may still reload the app.
 */
function WallDisplayLayout() {
  const stackScreenOptions = useStackScreenOptions();
  const { systemColors } = useTheme();
  // The glass stack draws transparent content over the root backstop. Under a
  // transparentModal that would show the tabs through every page pushed here, so
  // each one gets the opaque system background.
  const screenOptions = useMemo(
    () => ({ ...stackScreenOptions, contentStyle: { backgroundColor: systemColors.background } }),
    [stackScreenOptions, systemColors.background],
  );

  return (
    <Stack screenOptions={screenOptions}>
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="settings" options={{ headerShown: false }} />
    </Stack>
  );
}

export default holdUntilLaunchReady(WallDisplayLayout);
