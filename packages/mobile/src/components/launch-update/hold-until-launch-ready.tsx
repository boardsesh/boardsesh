import type { ComponentType } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack } from 'expo-router';
import { ActivityIndicator } from '../ActivityIndicator';
import { useLaunchHoldReleased } from '../../lib/launch-hold';

type LaunchHoldOptions = {
  /**
   * The root stack shows a header for this route and the route sets its title
   * from inside the screen. While held that screen is not mounted, so the hold
   * supplies an empty title instead of letting the raw route name show.
   */
  header?: 'visible';
};

const HELD_HEADER_OPTIONS = { title: '' };

function LaunchHold({ header }: LaunchHoldOptions) {
  return (
    <View style={styles.hold}>
      {header === 'visible' ? <Stack.Screen options={HELD_HEADER_OPTIONS} /> : null}
      <ActivityIndicator size="large" />
    </View>
  );
}

/**
 * Wrap a root route that iOS presents as a native modal (`modal`,
 * `transparentModal`). Every such route in `app/_layout.tsx` is wrapped,
 * because a URL can open any of them on a cold start.
 *
 * A native modal is its own view controller above the React root, so the launch
 * update placeholder cannot cover it and the screen would be usable while the
 * gate is still deciding whether to reload. Held behind a spinner until launch
 * is ready, nothing on it can be mid-tap when a reload lands. Every other route
 * sits under the placeholder and needs none of this.
 *
 * Once launch is ready this is a passthrough: the hold reads one boolean from
 * context that never changes again, so it adds no re-render to the screen.
 */
export function holdUntilLaunchReady<ScreenProps extends object>(
  Screen: ComponentType<ScreenProps>,
  options: LaunchHoldOptions = {},
): ComponentType<ScreenProps> {
  function HeldScreen(props: ScreenProps) {
    const released = useLaunchHoldReleased();
    if (!released) return <LaunchHold header={options.header} />;
    return <Screen {...props} />;
  }
  HeldScreen.displayName = `HoldUntilLaunchReady(${Screen.displayName ?? Screen.name})`;
  return HeldScreen;
}

const styles = StyleSheet.create({
  hold: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
