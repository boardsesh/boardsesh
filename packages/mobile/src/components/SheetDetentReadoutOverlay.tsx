import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSetting } from '../settings';
import { useDiagnosticsEligible } from '../hooks/use-diagnostics-eligible';
import {
  clearSheetDetentReadings,
  setSheetDetentReadoutActive,
  useSheetDetentReadings,
  type SheetDetentReading,
} from './sheet-detent-readout';

/**
 * On-screen readout of the #3922 sheet-detent measurements.
 *
 * #3922 will not accept a column-height change without device numbers from an
 * iPhone SE 3 / iOS 26 and an iPhone 16 / iOS 26.5 — a wrong guess clips the
 * Apply/Save button on every `%`-detent sheet, which is worse than the dead gap
 * it would be trying to close. The instrumentation that produces those numbers
 * (PR #4082) prints to the console, which only exists in a dev client attached
 * to Metro. This panel puts the same numbers on screen so they can come off a
 * TestFlight or preview install instead.
 *
 * Mounted at the root, behind the persisted toggle plus the diagnostics
 * eligibility gate, and reading a store the probe writes — so it never
 * participates in the sheet's own layout. It also resolves that gate ON BEHALF
 * of the sheets: they reach the store through `sheet-detent-probe.ts` and so
 * cannot import `../settings` without dragging MMKV into every sheet's module
 * graph (which breaks Vitest's collection scan).
 *
 * A native iOS sheet presents above the root view, so this panel is covered
 * while a sheet is up. That is why readings survive dismissal: open the sheet,
 * close it, screenshot the panel.
 */
export function SheetDetentReadoutOverlay() {
  const eligible = useDiagnosticsEligible();
  const [toggledOn] = useSetting('sheetDetentDiagnostics');
  // A production install can flip nothing, because the row never renders — but a
  // stale persisted `true` from an earlier preview must not turn it on either.
  const enabled = eligible && toggledOn;
  const readings = useSheetDetentReadings();

  // This root-mounted component owns the settings read for the whole feature and
  // pushes the result down to the sheets, which cannot import MMKV themselves —
  // see the module doc on sheet-detent-readout.ts.
  useEffect(() => {
    setSheetDetentReadoutActive(enabled);
  }, [enabled]);

  if (!enabled) return null;
  return <SheetDetentReadoutPanel readings={readings} />;
}

function formatMeasurement(value: number | null): string {
  return value === null ? '—' : String(Math.round(value * 10) / 10);
}

function SheetDetentReadoutPanel({ readings }: { readings: SheetDetentReading[] }) {
  const insets = useSafeAreaInsets();
  return (
    // `box-none` on the wrapper and `auto` only on the Clear button: the panel
    // must not swallow taps meant for the screen underneath it.
    <View pointerEvents="box-none" style={[styles.root, { top: insets.top + 4 }]}>
      <View style={styles.panel} pointerEvents="box-none">
        <View style={styles.titleRow} pointerEvents="box-none">
          {/* i18n-ignore-next-line — tester-only diagnostics */}
          <Text style={styles.title}>SHEET DETENT #3922</Text>
          <Pressable onPress={clearSheetDetentReadings} hitSlop={8} accessibilityRole="button">
            {/* i18n-ignore-next-line */}
            <Text style={styles.clear}>CLEAR</Text>
          </Pressable>
        </View>
        {readings.length === 0 ? (
          // i18n-ignore-next-line
          <Text style={styles.hint}>Open a sheet, then close it to read the numbers.</Text>
        ) : (
          readings.map((reading) => (
            // Keyed by sheet label, not sequence: a new reading for the same
            // sheet replaces the old one in place rather than remounting a row.
            <View key={reading.sheet} style={styles.reading} pointerEvents="none">
              <Text style={styles.sheetName} selectable>
                {`${reading.sheet}  #${reading.sequence}`}
              </Text>
              <Text style={styles.metrics} selectable>
                {`win ${formatMeasurement(reading.window.width)}x${formatMeasurement(reading.window.height)}  ` +
                  `ins ${formatMeasurement(reading.insets.top)}/${formatMeasurement(reading.insets.bottom)}`}
              </Text>
              <Text style={styles.metrics} selectable>
                {`formula ${formatMeasurement(reading.formulaHeight)}  column ${formatMeasurement(reading.columnHeight)}`}
              </Text>
              <Text style={styles.metrics} selectable>
                {`probe ${formatMeasurement(reading.probeHeight)}  padTop ${formatMeasurement(reading.sentinelY)}`}
              </Text>
              {/* The number every prior formula was trying to guess — the one
                  that decides whether the fix is JS-side or upstream. */}
              <Text style={styles.headline} selectable>
                {`inFlow ${formatMeasurement(reading.availableInFlowHeight)}`}
              </Text>
            </View>
          ))
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    left: 8,
    zIndex: 99999,
    elevation: 99999,
    alignItems: 'flex-start',
  },
  panel: {
    backgroundColor: 'rgba(0, 0, 0, 0.82)',
    borderColor: '#f59e0b',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    maxWidth: 240,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 2,
  },
  title: {
    color: '#f59e0b',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1,
  },
  clear: {
    color: '#f59e0b',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1,
  },
  hint: {
    color: '#d4d4d4',
    fontSize: 11,
  },
  reading: {
    marginTop: 4,
  },
  sheetName: {
    color: '#f59e0b',
    fontSize: 11,
    fontWeight: '600',
  },
  metrics: {
    color: '#ffffff',
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },
  headline: {
    color: '#34d399',
    fontSize: 12,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
});
