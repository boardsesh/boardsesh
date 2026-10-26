import { useEffect, useMemo } from 'react';
import { Stack } from 'expo-router';
import { DevicePickerSheetHost } from '../../src/components/ble/DevicePickerSheetHost';
import { holdUntilLaunchReady } from '../../src/components/launch-update/hold-until-launch-ready';
import { useStackScreenOptions } from '../../src/hooks/use-stack-screen-options';
import { useTheme } from '../../src/providers/theme-provider';
import { markWallDisplayMounted } from '../../src/lib/wall-display-presence';

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
 * While mounted it tells the shell behind it that the display is up
 * (`wall-display-presence.ts`), even with a page pushed over it, and it hosts
 * the BLE device picker: the kiosk's Connect buttons would otherwise present
 * the app-root picker underneath this modal, out of reach.
 *
 * Held until launch is ready: the old `wall` link can open it on a cold start,
 * while the launch update gate may still reload the app.
 */
function WallDisplayLayout() {
  const stackScreenOptions = useStackScreenOptions();
  const { systemColors } = useTheme();
  useEffect(() => markWallDisplayMounted(), []);
  // The glass stack draws transparent content over the root backstop. Under a
  // transparentModal that would show the tabs through every page pushed here, so
  // each one gets the opaque system background.
  const screenOptions = useMemo(
    () => ({ ...stackScreenOptions, contentStyle: { backgroundColor: systemColors.background } }),
    [stackScreenOptions, systemColors.background],
  );

  return (
    <>
      <Stack screenOptions={screenOptions}>
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="settings" options={{ headerShown: false }} />
      </Stack>
      {/* Claims the picker from the app-root host while mounted, as /play does, so
          Connect in the kiosk presents over this modal instead of behind it. */}
      <DevicePickerSheetHost registerExternal />
    </>
  );
}

export default holdUntilLaunchReady(WallDisplayLayout);
