// Keyboard calibration readout for iOS sheets (#5964). Drawn only while the
// `sheet-keyboard-calibration` flag is on (see SheetKeyboardCalibrationPublisher);
// with it off, `Sheet` / `ModalSheet` never mount this, so no probe Host, no
// listener and no layout work exists.
//
// Why it exists: on iOS the chrome column's keyboard padding is computed from
// `measureInWindow`, but inside an `@expo/ui` sheet that measurement stops at the
// sheet's `RNHostView` (a layout root), so it is relative to the sheet, not the
// window, and the padding comes up short by the sheet's distance from the top
// of the screen. This readout compares the original three replacement designs:
//
// - the `.global` frame SwiftUI reports for a probe Host (window space?),
// - the sheet host's own height, if SwiftUI shrinks it to the keyboard top (K),
// - the window height minus the host height, if the host reaches the window
//   bottom (F).
//
// The iOS 26.5 simulator confirmed K: the host shrinks to the keyboard top.
// This readout keeps the raw numbers for comparisons across devices. It is an OBSERVER: every
// view it adds is absolutely positioned and touch-transparent, and nothing it
// measures reaches `useSheetKeyboardInset`.
import { useCallback, useEffect, useReducer, useRef, useState, type RefObject } from 'react';
import {
  Keyboard,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type KeyboardEvent,
  type KeyboardEventName,
  type LayoutChangeEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { textStyles } from '../theme/typography';
import { SheetWindowOriginProbe } from './sheet-window-origin-probe';
import type { SheetWindowFrame } from './sheet-window-origin-probe.types';
import { useSheetKeyboardCalibrationWindowTopInset } from '../lib/sheet-keyboard-calibration-store';

/** Milliseconds since the readout mounted. */
type Stamp = { atMs: number };

export type CalibrationKeyboard = Stamp & { event: KeyboardEventName; screenY: number; height: number; width: number };

export type CalibrationReadings = {
  keyboard: CalibrationKeyboard | null;
  /** SwiftUI `frame(in: .global)` of the probe Host at the host's top-left corner. */
  globalProbe: (Stamp & { y: number; height: number }) | null;
  /** `measureInWindow` of that same probe view: sheet-relative if the layout-root reading holds. */
  measuredProbe: (Stamp & { y: number }) | null;
  /** `measureInWindow` of the chrome column. */
  column: (Stamp & { y: number; height: number }) | null;
  /** `onLayout` of an absolute fill beside the column: the sheet host's height. */
  host: (Stamp & { height: number }) | null;
};

export type CalibrationPhase = 'down' | 'up';

export type CalibrationState = {
  phase: CalibrationPhase;
  /** When the latest keyboard event arrived; every other time is shown relative to it. */
  keyboardAt: number | null;
  down: CalibrationReadings;
  up: CalibrationReadings;
};

const NO_READINGS: CalibrationReadings = {
  keyboard: null,
  globalProbe: null,
  measuredProbe: null,
  column: null,
  host: null,
};

export const INITIAL_CALIBRATION_STATE: CalibrationState = {
  phase: 'down',
  keyboardAt: null,
  down: NO_READINGS,
  up: NO_READINGS,
};

type CalibrationAction =
  | { kind: 'keyboard'; phase: CalibrationPhase; keyboard: CalibrationKeyboard }
  | { kind: 'reading'; reading: Partial<Omit<CalibrationReadings, 'keyboard'>> };

export function reduceCalibration(state: CalibrationState, action: CalibrationAction): CalibrationState {
  if (action.kind === 'keyboard') {
    // A phase change starts from the readings so far, so a value that did not
    // move still shows (with its earlier time) instead of a blank.
    return {
      ...state,
      phase: action.phase,
      keyboardAt: action.keyboard.atMs,
      [action.phase]: { ...state[state.phase], keyboard: action.keyboard },
    };
  }
  return { ...state, [state.phase]: { ...state[state.phase], ...action.reading } };
}

/** Whether a keyboard event leaves the keyboard on screen. */
export function keyboardPhase(
  event: KeyboardEventName,
  end: { screenY: number; height: number } | undefined,
  windowHeight: number,
): CalibrationPhase {
  if (event === 'keyboardWillHide' || event === 'keyboardDidHide') return 'down';
  if (!end || end.height <= 0 || end.screenY >= windowHeight) return 'down';
  return 'up';
}

export type CalibrationCandidates = {
  /** The column's window bottom from the `.global` probe, minus the keyboard top. */
  globalProbe: number | null;
  /** K: the host ends at the keyboard top, so the overlap is the column's overflow past it. */
  hostEndsAtKeyboard: number | null;
  /** F: the host reaches the window bottom, so the sheet's top is window − host. */
  hostEndsAtWindowBottom: number | null;
};

/**
 * The column padding each design would apply for these readings: the distance
 * from the column's bottom to the keyboard's top. Whichever puts the action bar
 * just above the keyboard on a real phone is the design to build.
 */
export function calibrationCandidates(readings: CalibrationReadings, windowHeight: number): CalibrationCandidates {
  const { keyboard, column, host, globalProbe, measuredProbe } = readings;
  if (!keyboard || !column) return { globalProbe: null, hostEndsAtKeyboard: null, hostEndsAtWindowBottom: null };
  const columnBottomInHost = column.y + column.height;
  return {
    globalProbe:
      globalProbe && measuredProbe
        ? Math.round(globalProbe.y - measuredProbe.y + columnBottomInHost - keyboard.screenY)
        : null,
    hostEndsAtKeyboard: host ? Math.round(columnBottomInHost - host.height) : null,
    hostEndsAtWindowBottom: host
      ? Math.round(windowHeight - host.height + columnBottomInHost - keyboard.screenY)
      : null,
  };
}

function formatNumber(value: number | null | undefined): string {
  return value == null ? '—' : String(Math.round(value * 10) / 10);
}

function formatTime(stamp: Stamp | null, keyboardAt: number | null): string {
  if (!stamp) return '';
  const relative = Math.round(stamp.atMs - (keyboardAt ?? 0));
  return ` @${relative >= 0 ? '+' : ''}${relative}ms`;
}

export type CalibrationContext = {
  label: string;
  windowWidth: number;
  windowHeight: number;
  rootTopInset: number | null;
  localTopInset: number;
  keyboardOverlap: number;
  bottomInset: number;
};

/** The readout's text, one entry per line, keyed by a stable line name. */
export function calibrationLines(state: CalibrationState, context: CalibrationContext): Array<[string, string]> {
  const { keyboardAt } = state;
  const lines: Array<[string, string]> = [
    ['title', `#5964 keyboard calibration · ${context.label} · now ${state.phase}`],
    [
      'window',
      `window ${formatNumber(context.windowWidth)}×${formatNumber(context.windowHeight)}` +
        ` · safe top root ${formatNumber(context.rootTopInset)} local ${formatNumber(context.localTopInset)}` +
        ` · padding now ${formatNumber(context.keyboardOverlap)} inset ${formatNumber(context.bottomInset)}`,
    ],
  ];
  for (const phase of ['down', 'up'] as const) {
    const readings = state[phase];
    const { keyboard, globalProbe, measuredProbe, column, host } = readings;
    lines.push([
      `${phase}-keyboard`,
      `${phase.toUpperCase()} keyboard ` +
        (keyboard
          ? `top ${formatNumber(keyboard.screenY)} h ${formatNumber(keyboard.height)} w ${formatNumber(keyboard.width)}` +
            ` ${keyboard.event}${formatTime(keyboard, keyboardAt)}`
          : '—'),
    ]);
    lines.push([
      `${phase}-probe`,
      `  .global y ${formatNumber(globalProbe?.y)}${formatTime(globalProbe, keyboardAt)}` +
        ` · measureInWindow y ${formatNumber(measuredProbe?.y)}${formatTime(measuredProbe, keyboardAt)}`,
    ]);
    lines.push([
      `${phase}-column`,
      `  column y ${formatNumber(column?.y)} h ${formatNumber(column?.height)}` +
        ` bottom ${formatNumber(column ? column.y + column.height : null)}${formatTime(column, keyboardAt)}` +
        ` · host h ${formatNumber(host?.height)}${formatTime(host, keyboardAt)}`,
    ]);
  }
  const candidates = calibrationCandidates(state.up, context.windowHeight);
  lines.push([
    'candidates',
    `UP padding by design: .global ${formatNumber(candidates.globalProbe)}` +
      ` · K ${formatNumber(candidates.hostEndsAtKeyboard)} · F ${formatNumber(candidates.hostEndsAtWindowBottom)}`,
  ]);
  return lines;
}

/** Re-measure right away and while the keyboard and the sheet settle. The
 * repo's iOS sheet settle ceiling is 550 ms; 1200 ms covers a slow raise. */
export const CALIBRATION_MEASURE_DELAYS_MS = [0, 150, 600, 1200] as const;

const KEYBOARD_EVENTS: readonly KeyboardEventName[] = [
  'keyboardWillShow',
  'keyboardDidShow',
  'keyboardWillChangeFrame',
  'keyboardDidChangeFrame',
  'keyboardWillHide',
  'keyboardDidHide',
];

export const CALIBRATION_LOG_TAG = '[sheet-keyboard #5964]';

type SheetKeyboardCalibrationProps = {
  /** Which wrapper drew it, so a log line names its sheet family. */
  label: string;
  /** The chrome column `useSheetKeyboardInset` pads. Measured, never written. */
  columnRef: RefObject<View | null>;
  /** What the shipped padding currently applies, for comparison. */
  keyboardOverlap: number;
  bottomInset: number;
};

/**
 * Render as a direct child of the native sheet, beside the chrome column (like
 * the #3922 probe). Every view here is absolutely positioned, so the column
 * stays the sheet's only in-flow child.
 */
export function SheetKeyboardCalibration({
  label,
  columnRef,
  keyboardOverlap,
  bottomInset,
}: SheetKeyboardCalibrationProps) {
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const { top: localTopInset } = useSafeAreaInsets();
  const rootTopInset = useSheetKeyboardCalibrationWindowTopInset();
  const [state, dispatch] = useReducer(reduceCalibration, INITIAL_CALIBRATION_STATE);
  // A new key remounts the probe Host, which makes SwiftUI report its frame again.
  const [probeGeneration, setProbeGeneration] = useState(0);
  const probeRef = useRef<View>(null);
  const mountedAtRef = useRef(Date.now());
  const phaseRef = useRef<CalibrationPhase>('down');
  const windowHeightRef = useRef(windowHeight);
  windowHeightRef.current = windowHeight;
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const elapsed = useCallback(() => Date.now() - mountedAtRef.current, []);

  const record = useCallback(
    (reading: Partial<Omit<CalibrationReadings, 'keyboard'>>) => {
      console.info(CALIBRATION_LOG_TAG, JSON.stringify({ sheet: label, phase: phaseRef.current, ...reading }));
      dispatch({ kind: 'reading', reading });
    },
    [label],
  );

  const measure = useCallback(() => {
    columnRef.current?.measureInWindow((_x, y, _width, height) => record({ column: { y, height, atMs: elapsed() } }));
    probeRef.current?.measureInWindow((_x, y) => record({ measuredProbe: { y, atMs: elapsed() } }));
    setProbeGeneration((generation) => generation + 1);
  }, [columnRef, elapsed, record]);

  const scheduleMeasurements = useCallback(() => {
    for (const timer of timersRef.current) clearTimeout(timer);
    timersRef.current = CALIBRATION_MEASURE_DELAYS_MS.map((delay) => setTimeout(measure, delay));
  }, [measure]);

  useEffect(() => {
    scheduleMeasurements();
    const subscriptions = KEYBOARD_EVENTS.map((event) =>
      Keyboard.addListener(event, (payload: KeyboardEvent | undefined) => {
        const end = payload?.endCoordinates;
        const phase = keyboardPhase(event, end, windowHeightRef.current);
        const keyboard: CalibrationKeyboard = {
          event,
          screenY: end?.screenY ?? Number.NaN,
          height: end?.height ?? 0,
          width: end?.width ?? 0,
          atMs: elapsed(),
        };
        phaseRef.current = phase;
        console.info(CALIBRATION_LOG_TAG, JSON.stringify({ sheet: label, phase, keyboard }));
        dispatch({ kind: 'keyboard', phase, keyboard });
        scheduleMeasurements();
      }),
    );
    return () => {
      for (const subscription of subscriptions) subscription.remove();
      for (const timer of timersRef.current) clearTimeout(timer);
      timersRef.current = [];
    };
  }, [elapsed, label, scheduleMeasurements]);

  const handleHostLayout = useCallback(
    (event: LayoutChangeEvent) => record({ host: { height: event.nativeEvent.layout.height, atMs: elapsed() } }),
    [elapsed, record],
  );
  const handleProbeFrame = useCallback(
    (frame: SheetWindowFrame) => record({ globalProbe: { y: frame.y, height: frame.height, atMs: elapsed() } }),
    [elapsed, record],
  );

  const lines = calibrationLines(state, {
    label,
    windowWidth,
    windowHeight,
    rootTopInset,
    localTopInset,
    keyboardOverlap,
    bottomInset,
  });

  return (
    <>
      <View
        testID="sheet-keyboard-calibration-host"
        pointerEvents="none"
        style={styles.fill}
        onLayout={handleHostLayout}
      />
      <SheetWindowOriginProbe key={probeGeneration} ref={probeRef} onFrame={handleProbeFrame} style={styles.probe} />
      <View testID="sheet-keyboard-calibration-readout" pointerEvents="none" style={styles.panel}>
        {lines.map(([lineKey, text]) => (
          <Text key={lineKey} allowFontScaling={false} style={lineKey === 'title' ? styles.title : styles.line}>
            {text}
          </Text>
        ))}
      </View>
    </>
  );
}

// Diagnostic chrome, deliberately outside the theme: it has to read the same on
// every sheet surface and in both appearances (same palette as the bottom-chrome
// readout).
const styles = StyleSheet.create({
  fill: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
  probe: { position: 'absolute', top: 0, left: 0, width: 1, height: 1 },
  panel: {
    position: 'absolute',
    top: 24,
    left: 8,
    right: 8,
    zIndex: 99999,
    backgroundColor: 'rgba(0, 0, 0, 0.82)',
    borderColor: '#34d399',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  title: { color: '#34d399', fontSize: textStyles.caption2.fontSize, fontWeight: '700' },
  line: { color: '#ffffff', fontSize: textStyles.caption2.fontSize, fontVariant: ['tabular-nums'] },
});
