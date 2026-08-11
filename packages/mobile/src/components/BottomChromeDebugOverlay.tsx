import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSetting } from '../settings';
import { useDiagnosticsEligible } from '../hooks/use-diagnostics-eligible';
import { useBottomChromeMetrics } from '../hooks/use-bottom-chrome-metrics';
import { useNativeTabBar } from '../hooks/use-bottom-accessory';
import { useTheme } from '../providers/theme-provider';
import {
  useNativeTabContentInsetBottom,
  useNativeTabContentInsetPublishCount,
} from '../lib/native-tab-content-inset-store';
import { usePublishedWindowInsetBottom } from '../lib/window-inset-store';

/**
 * Live readout of the bottom-chrome geometry: the ROOT safe-area inset, the
 * in-tab measurement published by `NativeTabContentInsetProbe`, the store's
 * publish counter, and the derived metrics every bottom-chrome consumer
 * positions with. Bottom-chrome bugs are invisible in code review and only show
 * on device (see bottom-chrome-metrics.ts), and they have recurred across
 * #3967 → #2611 → #3973 → #4089 — so this overlay is a permanent diagnostic,
 * not a one-off: it lets a tester on an OTA preview verify the geometry without
 * a rebuild.
 *
 * The publish counter is the minimize-cadence gate: scroll a long list so the
 * native bar minimizes and back; a handful of increments means UIKit delivers
 * discrete inset events, a large jump means per-frame streaming and the store
 * needs its coalescing enabled (see native-tab-content-inset-store.ts).
 *
 * Off unless BOTH hold: the persisted "Bottom chrome diagnostics" toggle
 * (More → Diagnostics) is on, and the session is diagnostic-eligible — a dev
 * build, an EAS preview build, or a `pr-<N>` OTA channel override (the per-PR
 * preview a production install can switch onto).
 */

export function BottomChromeDebugOverlay() {
  const eligible = useDiagnosticsEligible();
  const [enabled] = useSetting('bottomChromeDiagnostics');
  if (!eligible || !enabled) return null;
  return <BottomChromeDebugOverlayInner />;
}

function formatOffset(value: number): string {
  return String(Math.round(value * 10) / 10);
}

function BottomChromeDebugOverlayInner() {
  // This component mounts at the root, so `insets` here IS the root sampling
  // point — the same value computeBottomChromeMetrics receives as insetsBottom.
  const insets = useSafeAreaInsets();
  const measured = useNativeTabContentInsetBottom();
  const publishCount = useNativeTabContentInsetPublishCount();
  const windowInset = usePublishedWindowInsetBottom();
  const metrics = useBottomChromeMetrics();
  const usesNativeTabBar = useNativeTabBar();
  const { variant } = useTheme();

  // Keyed by the stable row label (position in this fixed list), NOT the line
  // content — a content key would remount every Text on each geometry change.
  const lines: Array<[rowKey: string, text: string]> = [
    [
      'insets',
      `root ${formatOffset(insets.bottom)}  probe ${measured === null ? '—' : formatOffset(measured)}  pubs ${publishCount}`,
    ],
    ['window', `window(sheets) ${windowInset === null ? '—' : formatOffset(windowInset)}`],
    [
      'flags',
      `${variant}  nativeBar ${usesNativeTabBar ? 'Y' : 'N'}  inTabs ${metrics.insideTabs ? 'Y' : 'N'}  ` +
        `acc ${metrics.nativeAccessoryVisible ? 'Y' : 'N'}  jsQ ${metrics.jsQueueToolbarVisible ? 'Y' : 'N'}`,
    ],
    ['bar', `tabBarBottom ${formatOffset(metrics.tabBarBottom)}  scroll ${formatOffset(metrics.scrollBottomPadding)}`],
    [
      'session',
      `preSession ${formatOffset(metrics.preSessionFooterBottom)}  inSession ${formatOffset(metrics.inSessionListBottom)}`,
    ],
    [
      'overlays',
      `floating ${formatOffset(metrics.floatingControlBottom)}  fixed ${formatOffset(metrics.fixedFooterBottom)}`,
    ],
  ];

  return (
    <View pointerEvents="box-none" style={[styles.root, { top: insets.top + 4 }]}>
      <View style={styles.panel}>
        <Text style={styles.title}>BOTTOM CHROME</Text>
        {lines.map(([rowKey, text]) => (
          <Text key={rowKey} style={styles.metrics}>
            {text}
          </Text>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    right: 8,
    zIndex: 99999,
    elevation: 99999,
    alignItems: 'flex-end',
  },
  panel: {
    backgroundColor: 'rgba(0, 0, 0, 0.82)',
    borderColor: '#34d399',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  title: {
    color: '#34d399',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1,
    marginBottom: 2,
  },
  metrics: {
    color: '#ffffff',
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },
});
