import { useCallback, useMemo, useRef } from 'react';
import { StyleSheet, useWindowDimensions, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { publishSheetDetentReading, useSheetDetentReadoutActive } from './sheet-detent-readout';

/**
 * Instrumentation for the iOS sheet detent height (#3922).
 *
 * `useSheetColumnStyle` computes the column height from `useWindowDimensions()`
 * plus tuned constants. Four merged revisions of that formula (#3352, #3371,
 * #3433, #3444) and one rejected one (#3611) never closed the ~142pt dead gap
 * reported on an iPhone SE 3 in #3776, and the two competing models of how
 * SwiftUI resolves `.fraction(f)` disagree by 30–50pt. #3922's acceptance
 * criteria ask for device numbers before any further change lands.
 *
 * This hook collects those numbers. It is an OBSERVER: nothing it measures
 * feeds back into layout, so the rendered tree is byte-identical to main.
 *
 * It runs in a dev client (where it prints `[sheet-detent #3922]`), and — since
 * a distributed build has no console to print to — also whenever a tester turns
 * on the "Sheet detent readout" toggle (More → Diagnostics, dev / preview /
 * `pr-` channel sessions only). In that case the same payload goes to
 * `sheet-detent-readout.ts`, which an overlay renders on screen so the numbers
 * can be screenshotted off a TestFlight build. With the toggle off, a
 * production session mounts nothing and renders exactly as it does today.
 *
 * ## What gets measured, and why it takes three probes
 *
 * `@expo/ui`'s iOS sheet does not hand our children straight to the native
 * host. `BottomSheet.ios.tsx` wraps them in
 * `<View style={{ flexGrow: 1, height: 0, paddingTop: 16 }}>` inside
 * `RNHostView`, whose Yoga node is sized by SwiftUI through
 * `ReportSizeToYogaNodeModifier` → `shadowNodeProxy.setViewSize()`
 * (`RNHostView.swift`). `SheetScrollContextReset` renders no host view, so our
 * children are direct Yoga children of that wrapper.
 *
 * - **probe** — `StyleSheet.absoluteFill`. An absolutely positioned child with
 *   all four insets set resolves against its containing block's PADDING box,
 *   not its content box (Yoga `AbsoluteLayout.cpp`; CSS-correct). Verified
 *   against the repo's own `yoga-layout@3.2.1` on the wrapper subtree above:
 *   with `setViewSize` = 548 and `paddingTop` = 16, the probe reports **548**
 *   while the in-flow column receives **532**. So the probe alone reads one
 *   `paddingTop` LONG — driving a column height from it would push a pinned
 *   footer past the detent, which is #3330 (a clipped Apply/Save) rather than
 *   #3776 (a cosmetic dead gap).
 * - **sentinel** — an in-flow, zero-height first child. Its `layout.y` is the
 *   wrapper's real `paddingTop`, which `BottomSheet.ios.tsx` makes conditional
 *   (`handleComponent !== null ? 16 : 0`). Measuring it beats assuming 16.
 *   A zero-height child adds nothing to the wrapper's content size.
 * - **column** — the view actually carrying `useSheetColumnStyle`'s height.
 *   Comparing it against the formula answers whether the computed height is
 *   honoured at all, which is what separates the two branches in #3922.
 *
 * The available in-flow height is therefore `probeHeight − sentinelY`, and the
 * point of this instrumentation is to learn that number on a real device before
 * anything acts on it.
 *
 * ## Reading the log
 *
 * On an iPhone SE 3 / iOS 26 (window 667, the device from #3330 and #3776):
 * - `probeHeight − sentinelY ≈ 548` — the native size report is right and the
 *   formula is only ~7pt off, so the column height is NOT the lever for
 *   #3776's 142pt gap; the gap lives elsewhere in the tree.
 * - `probeHeight − sentinelY ≈ 391` — the SwiftUI → Yoga size report is itself
 *   short of the real detent, which matches the ~390pt column measured on
 *   #3776. No JS formula could ever have been right, and the fix belongs
 *   upstream in `RNHostView` / Expo rather than here.
 *
 * A `columnHeight` that does not match `formulaHeight` means the computed
 * height is not reaching the view, which would make both branches moot.
 */

/** One measurement epoch. Keyed on the formula height, which already moves with
 * the active detent and the window size, so no extra reset plumbing is needed. */
type ProbeEpoch = {
  key: number | null;
  probeHeight: number | null;
  columnHeight: number | null;
  sentinelY: number | null;
  logged: boolean;
};

export type SheetDetentProbeProps = {
  style: StyleProp<ViewStyle>;
  pointerEvents: 'none';
  onLayout: (event: LayoutChangeEvent) => void;
};

export type SheetDetentProbe = {
  /** Absolute-fill observer. Out of flow, so it contributes nothing to the
   * wrapper's content size in either of Expo's two layout branches. */
  probeProps: SheetDetentProbeProps | null;
  /** Zero-height in-flow first child. `layout.y` is the wrapper's paddingTop. */
  sentinelProps: SheetDetentProbeProps | null;
  /** Attach to the view carrying `useSheetColumnStyle`'s style. */
  onColumnLayout: ((event: LayoutChangeEvent) => void) | undefined;
};

const IDLE: SheetDetentProbe = { probeProps: null, sentinelProps: null, onColumnLayout: undefined };

const probeStyles = StyleSheet.create({ sentinel: { height: 0 } });

/**
 * Whether a sheet should mount the probe views at all.
 *
 * Split out as a pure function because Metro AND the test config replace
 * `__DEV__` with a literal, so the production-with-toggle-off branch is
 * unreachable from a test that reads the global.
 *
 * @param isDev the `__DEV__` compile-time constant.
 * @param readoutEnabled tester toggle + diagnostics eligibility.
 * @param formulaHeight null for every unbounded column — Android, web,
 *   `enableDynamicSizing`, non-`%` detents — which #3922 does not touch.
 */
export function shouldInstrumentSheetDetent(
  isDev: boolean,
  readoutEnabled: boolean,
  formulaHeight: number | null,
): boolean {
  if (formulaHeight == null) return false;
  return isDev || readoutEnabled;
}

/**
 * @param columnStyle the style returned by `useSheetColumnStyle`. Instrumentation
 *   runs only when that style carries a numeric height — i.e. exactly the iOS
 *   fixed-detent sheets #3922 is about. Android, web, `enableDynamicSizing` and
 *   non-`%` detents all yield `flex: 1` and are left completely untouched.
 * @param label identifies the sheet in the log line.
 */
export function useSheetDetentProbe(columnStyle: ViewStyle, label: string): SheetDetentProbe {
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const readoutEnabled = useSheetDetentReadoutActive();
  const formulaHeight = typeof columnStyle.height === 'number' ? columnStyle.height : null;

  const epoch = useRef<ProbeEpoch>({
    key: null,
    probeHeight: null,
    columnHeight: null,
    sentinelY: null,
    logged: false,
  });

  // Kept in a ref so the layout callbacks stay referentially stable: the probe
  // views must never remount, and a re-render must not re-arm the log.
  const context = useRef({ window, insets, formulaHeight, label, readoutEnabled });
  context.current = { window, insets, formulaHeight, label, readoutEnabled };

  const record = useCallback((field: 'probeHeight' | 'columnHeight' | 'sentinelY', measured: number) => {
    const {
      formulaHeight: key,
      window: dimensions,
      insets: safeArea,
      label: sheetLabel,
      readoutEnabled: publishToOverlay,
    } = context.current;
    if (key == null) return;
    const current = epoch.current;
    if (current.key !== key) {
      // New detent or new window size — drop the previous epoch's readings
      // rather than mixing them into one log line.
      epoch.current = { key, probeHeight: null, columnHeight: null, sentinelY: null, logged: false };
    }
    const next = epoch.current;
    next[field] = measured;
    const availableInFlowHeight =
      next.probeHeight == null || next.sentinelY == null ? null : next.probeHeight - next.sentinelY;
    const payload = {
      sheet: sheetLabel,
      window: { width: dimensions.width, height: dimensions.height },
      insets: { top: safeArea.top, bottom: safeArea.bottom },
      formulaHeight: key,
      probeHeight: next.probeHeight,
      columnHeight: next.columnHeight,
      sentinelY: next.sentinelY,
      // The number every prior formula was trying to guess.
      availableInFlowHeight,
    };
    // The overlay takes every measurement as it lands, partial included: when a
    // tester flips the toggle while a sheet is already mounted, RN does not
    // re-fire `onLayout` on the column just because it gained a handler, so
    // waiting for all three would leave the panel permanently empty.
    if (publishToOverlay) publishSheetDetentReading(payload);
    // The log line stays all-or-nothing — one complete record per epoch.
    if (next.logged || next.probeHeight == null || next.columnHeight == null || next.sentinelY == null) {
      return;
    }
    next.logged = true;
    if (__DEV__) console.log('[sheet-detent #3922]', payload);
  }, []);

  const onProbeLayout = useCallback(
    (event: LayoutChangeEvent) => record('probeHeight', event.nativeEvent.layout.height),
    [record],
  );
  const onSentinelLayout = useCallback(
    (event: LayoutChangeEvent) => record('sentinelY', event.nativeEvent.layout.y),
    [record],
  );
  const onColumnLayout = useCallback(
    (event: LayoutChangeEvent) => record('columnHeight', event.nativeEvent.layout.height),
    [record],
  );

  const probeProps = useMemo<SheetDetentProbeProps>(
    () => ({ style: StyleSheet.absoluteFill, pointerEvents: 'none', onLayout: onProbeLayout }),
    [onProbeLayout],
  );
  const sentinelProps = useMemo<SheetDetentProbeProps>(
    () => ({ style: probeStyles.sentinel, pointerEvents: 'none', onLayout: onSentinelLayout }),
    [onSentinelLayout],
  );

  // Dev clients always instrument. A distributed build does so only while a
  // diagnostics-eligible tester has the readout toggle on, so an ordinary
  // production session mounts no probe views and renders exactly as it does now.
  if (!shouldInstrumentSheetDetent(__DEV__, readoutEnabled, formulaHeight)) return IDLE;
  return { probeProps, sentinelProps, onColumnLayout };
}
