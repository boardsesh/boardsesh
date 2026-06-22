import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  StatusBar,
  Dimensions,
  useWindowDimensions,
  type ScaledSize,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * Tester-only diagnostic overlay for the Android-16 edge-to-edge "touch-dead" bug
 * (Pixel 10 / Galaxy S24+). Renders ONLY when the app is built with
 * `EXPO_PUBLIC_FREEZE_DEBUG=1` (Metro inlines the flag at build time, so in a
 * normal/production build the inner component and its hooks dead-code-eliminate;
 * only a thin shell that returns null remains).
 *
 * It is mounted as a ROOT SIBLING of the navigator (next to PersistentQueueBar,
 * above the <Stack>), so its buttons stay tappable even when the main screen's
 * touch hit-region is dead — which is the whole point. In the frozen state the
 * tester can still read the live metrics and snapshot them, then enter split-screen
 * (which restores touch) and snapshot again. `win`/`scr` come from Dimensions
 * (independent of the frozen tree) and are the trustworthy signals; `ins` comes
 * from the SAME SafeAreaProvider the frozen <Stack> reads, so it can be equally
 * stale — treat it as corroborating, not decisive:
 *   - win/scr WRONG while frozen, correct after split-screen → edge-to-edge
 *     measurement path is the cause (the Theme.EdgeToEdge fix / RN 0.86).
 *   - metrics LOOK CORRECT while touch is still dead          → a stuck overlay,
 *     native theme/resource, or screen-container hit-region issue, not measurement.
 * "Nudge relayout" is a BEST-EFFORT JS inset re-dispatch (toggles the status bar);
 * it may be inert under mandatory edge-to-edge since it is not a real config
 * change. If it DOES restore touch, the freeze is an inset re-dispatch problem.
 */

const ENABLED = process.env.EXPO_PUBLIC_FREEZE_DEBUG === '1';

type Snapshot = {
  id: number;
  text: string;
};

export function FreezeDebugOverlay() {
  if (!ENABLED) {
    return null;
  }
  return <FreezeDebugOverlayInner />;
}

function FreezeDebugOverlayInner() {
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const [screen, setScreen] = useState<ScaledSize>(() => Dimensions.get('screen'));
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);

  useEffect(() => {
    const subscription = Dimensions.addEventListener('change', ({ screen: nextScreen }) => {
      setScreen(nextScreen);
    });
    return () => subscription.remove();
  }, []);

  const metrics =
    `win ${Math.round(window.width)}x${Math.round(window.height)}  ` +
    `scr ${Math.round(screen.width)}x${Math.round(screen.height)}  ` +
    `ins ${Math.round(insets.top)}/${Math.round(insets.right)}/${Math.round(insets.bottom)}/${Math.round(insets.left)}`;

  const snap = useCallback(() => {
    setSnapshots((items) => {
      const nextId = items.length === 0 ? 1 : items[0].id + 1;
      const text = `#${nextId}  ${metrics}`;
      // Also emit to logcat so it lands in the same session recording as the
      // "Invalid resource ID" spam, lining up the metrics with the frozen frame.
      console.warn(`[freeze-debug] ${text}`);
      return [{ id: nextId, text }, ...items].slice(0, 6);
    });
  }, [metrics]);

  const restoreTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const nudge = useCallback(() => {
    // Best-effort, may be inert under mandatory edge-to-edge: toggling the status
    // bar CAN make Android re-dispatch window insets + a layout pass (loosely what
    // a split-screen config change forces), but it is NOT a real Configuration
    // change, so on these devices it may do nothing. If it DOES restore touch
    // without split-screen, the freeze is an inset re-dispatch problem.
    StatusBar.setHidden(true, 'none');
    restoreTimer.current = setTimeout(() => StatusBar.setHidden(false, 'none'), 180);
  }, []);

  useEffect(
    () => () => {
      // Don't leak the timer or leave the bar hidden if we unmount mid-nudge.
      if (restoreTimer.current) {
        clearTimeout(restoreTimer.current);
      }
      StatusBar.setHidden(false, 'none');
    },
    [],
  );

  return (
    <View pointerEvents="box-none" style={[styles.root, { top: insets.top + 4 }]}>
      <View style={styles.panel}>
        <Text style={styles.title}>FREEZE DEBUG</Text>
        <Text style={styles.metrics}>{metrics}</Text>
        <View style={styles.buttonRow}>
          <Pressable onPress={snap} style={styles.button} hitSlop={8}>
            <Text style={styles.buttonText}>Snap</Text>
          </Pressable>
          <Pressable onPress={nudge} style={styles.button} hitSlop={8}>
            <Text style={styles.buttonText}>Nudge relayout</Text>
          </Pressable>
        </View>
        {snapshots.map((snapshot) => (
          <Text key={snapshot.id} style={styles.snapshot}>
            {snapshot.text}
          </Text>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    left: 8,
    right: 8,
    zIndex: 99999,
    elevation: 99999,
    alignItems: 'flex-start',
  },
  panel: {
    backgroundColor: 'rgba(0, 0, 0, 0.82)',
    borderColor: '#ff2d55',
    borderWidth: 2,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  title: {
    color: '#ff2d55',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    marginBottom: 2,
  },
  metrics: {
    color: '#ffffff',
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 6,
  },
  button: {
    backgroundColor: '#ff2d55',
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '600',
  },
  snapshot: {
    color: '#9fe7ff',
    fontSize: 11,
    marginTop: 3,
    fontVariant: ['tabular-nums'],
  },
});
