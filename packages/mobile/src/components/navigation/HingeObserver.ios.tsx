import { StyleSheet, View } from 'react-native';
import { Host, Spacer } from '@expo/ui/swift-ui';
import { onHingeChange, type HingeContext } from '@expo/ui/swift-ui/modifiers';
import { publishHingeStatus } from '../../lib/device-hinge-store';

function handleHingeChange(_previous: HingeContext, next: HingeContext) {
  publishHingeStatus(next.hinge?.status ?? null);
}

// Hoisted: one modifier list for every observer, so the Host never sees a new
// prop and the native side subscribes once per mount.
const HINGE_MODIFIERS = [onHingeChange(handleHingeChange)];

/**
 * A zero-size SwiftUI `Host` whose only job is SwiftUI's `onHingeChange`, which
 * `@expo/ui` exposes as a modifier and which needs a SwiftUI view to hang off.
 * It reports the iPhone Duo's hinge status into `device-hinge-store`; the store
 * keeps only "half open or not", so the angle stream never re-renders React.
 *
 * SwiftUI fires the modifier when the view appears (and again on every change),
 * so a fresh mount publishes the current status. Mounted once, by
 * `PhoneSplitHingeObserver`. A no-op on devices without a hinge and in builds
 * made before Xcode 27.1.
 */
export function HingeObserver() {
  return (
    <View pointerEvents="none" style={styles.root} importantForAccessibility="no-hide-descendants">
      <Host style={StyleSheet.absoluteFill} modifiers={HINGE_MODIFIERS}>
        <Spacer />
      </Host>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { position: 'absolute', width: 1, height: 1, opacity: 0 },
});
