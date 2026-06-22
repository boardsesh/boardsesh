import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  AppState,
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
 *
 * The production fix must happen before React's root view is attached. This
 * overlay stays read-only so diagnostic APKs can record whether the first root
 * layout is already stable without shipping a JS-triggered relayout bridge.
 * Metrics auto-snapshot on mount and whenever the app returns to the foreground,
 * so a tester who only knows how to screenshot still captures usable numbers.
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

  // Keep the latest metrics string in a ref so the auto-snapshot effects (which
  // must not re-run on every metric change) and the async action handlers can
  // read the current value without listing `metrics` in their deps.
  const metricsRef = useRef(metrics);
  metricsRef.current = metrics;

  const snap = useCallback((label?: string) => {
    setSnapshots((items) => {
      const nextId = items.length === 0 ? 1 : items[0].id + 1;
      const prefix = label ? `${label} ` : '';
      const text = `#${nextId}  ${prefix}${metricsRef.current}`;
      // Also emit to logcat so it lands in the same session recording as the
      // "Invalid resource ID" spam, lining up the metrics with the frozen frame.
      console.warn(`[freeze-debug] ${text}`);
      return [{ id: nextId, text }, ...items].slice(0, 6);
    });
  }, []);

  // Auto-snapshot on mount and every time the app returns to the foreground, so a
  // contributor who only screenshots still records the frozen-state numbers (and
  // the post-split-screen numbers when they switch back).
  useEffect(() => {
    snap('mount');
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        snap('fg');
      }
    });
    return () => subscription.remove();
  }, [snap]);

  return (
    <View pointerEvents="box-none" style={[styles.root, { top: insets.top + 4 }]}>
      <View style={styles.panel}>
        <Text style={styles.title}>FREEZE DEBUG</Text>
        <Text style={styles.metrics}>{metricsRef.current}</Text>
        <Text style={styles.instructions}>
          If the app won&apos;t respond after opening from a full close: tap Snap, screenshot this box, enter
          split-screen, then tap Snap again.
        </Text>
        <View style={styles.buttonRow}>
          <Pressable onPress={() => snap()} style={styles.button} hitSlop={8}>
            <Text style={styles.buttonText}>Snap</Text>
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
    maxWidth: '100%',
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
  instructions: {
    color: '#cfd8dc',
    fontSize: 11,
    lineHeight: 15,
    marginTop: 4,
  },
  buttonRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
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
