// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { act, render } from '@testing-library/react';
import { createElement, forwardRef, type ReactNode, type Ref, type RefObject } from 'react';
import type { ViewInstance as NativeView } from 'react-native';

type KeyboardListener = (event?: { endCoordinates?: { height: number; screenY: number; width: number } }) => void;
const native = vi.hoisted(() => ({
  listeners: new Map<string, KeyboardListener>(),
  removed: [] as string[],
}));

vi.mock('react-native', () => ({
  Keyboard: {
    addListener: (eventName: string, listener: KeyboardListener) => {
      native.listeners.set(eventName, listener);
      return {
        remove: () => {
          native.listeners.delete(eventName);
          native.removed.push(eventName);
        },
      };
    },
  },
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
  useWindowDimensions: () => ({ width: 402, height: 874 }),
  View: ({
    children,
    testID,
    onLayout,
  }: {
    children?: ReactNode;
    testID?: string;
    onLayout?: (event: { nativeEvent: { layout: { height: number } } }) => void;
  }) =>
    createElement(
      'div',
      {
        'data-testid': testID,
        // The host-height fill reports its layout when the test clicks it.
        onClick: onLayout ? () => onLayout({ nativeEvent: { layout: { height: 802 } } }) : undefined,
      },
      children,
    ),
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 34, left: 0, right: 0 }),
}));

// The SwiftUI probe can't mount under vitest. This stand-in exposes the two
// things the readout uses: its `onFrame` (fired by the test) and a ref that
// answers `measureInWindow` the way an in-sheet view does (sheet-relative 0).
const probe = vi.hoisted(() => ({
  onFrame: undefined as ((frame: { x: number; y: number; width: number; height: number }) => void) | undefined,
  mounts: 0,
}));
vi.mock('../sheet-window-origin-probe', async () => {
  const { useEffect, useImperativeHandle } = await import('react');
  return {
    SheetWindowOriginProbe: forwardRef(
      (
        { onFrame }: { onFrame: (frame: { x: number; y: number; width: number; height: number }) => void },
        ref: Ref<unknown>,
      ) => {
        probe.onFrame = onFrame;
        useEffect(() => {
          probe.mounts += 1;
        }, []);
        useImperativeHandle(ref, () => ({
          measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) =>
            callback(0, 0, 1, 1),
        }));
        return null;
      },
    ),
  };
});

import {
  CALIBRATION_LOG_TAG,
  CALIBRATION_MEASURE_DELAYS_MS,
  INITIAL_CALIBRATION_STATE,
  SheetKeyboardCalibration,
  calibrationCandidates,
  keyboardPhase,
  reduceCalibration,
  type CalibrationReadings,
} from '../sheet-keyboard-calibration';
import {
  publishSheetKeyboardCalibration,
  resetSheetKeyboardCalibrationForTests,
} from '../../lib/sheet-keyboard-calibration-store';

// iPhone 17 Pro sized: an 874pt window, a 336pt keyboard whose top is at 538,
// and a column at the sheet's 16pt wrapper padding, 689pt tall (90% detent).
const KEYBOARD = { height: 336, screenY: 538, width: 402 };

describe('calibrationCandidates', () => {
  const readings: CalibrationReadings = {
    keyboard: { event: 'keyboardDidChangeFrame', ...KEYBOARD, atMs: 0 },
    globalProbe: { y: 72, height: 1, atMs: 0 },
    measuredProbe: { y: 0, atMs: 0 },
    column: { y: 16, height: 689, atMs: 0 },
    host: { height: 802, atMs: 0 },
  };

  it('gives each design the column padding it would apply', () => {
    expect(calibrationCandidates(readings, 874)).toEqual({
      // Column bottom in the window (72 + 705) minus the keyboard top.
      globalProbe: 239,
      // A host that did not shrink for the keyboard says K is the wrong model.
      hostEndsAtKeyboard: 705 - 802,
      // The sheet top from the host height (874 − 802 = 72) gives the same 239.
      hostEndsAtWindowBottom: 239,
    });
  });

  it('pads by the column overflow when the host ends at the keyboard top (K)', () => {
    expect(calibrationCandidates({ ...readings, host: { height: 466, atMs: 0 } }, 874).hostEndsAtKeyboard).toBe(239);
  });

  it('leaves a design blank until its inputs have been measured', () => {
    expect(calibrationCandidates({ ...readings, keyboard: null }, 874)).toEqual({
      globalProbe: null,
      hostEndsAtKeyboard: null,
      hostEndsAtWindowBottom: null,
    });
    expect(calibrationCandidates({ ...readings, measuredProbe: null, host: null }, 874)).toEqual({
      globalProbe: null,
      hostEndsAtKeyboard: null,
      hostEndsAtWindowBottom: null,
    });
  });
});

describe('keyboardPhase', () => {
  it('reads hides and off-screen frames as down, everything else as up', () => {
    expect(keyboardPhase('keyboardWillChangeFrame', KEYBOARD, 874)).toBe('up');
    expect(keyboardPhase('keyboardWillHide', KEYBOARD, 874)).toBe('down');
    expect(keyboardPhase('keyboardDidChangeFrame', { ...KEYBOARD, screenY: 874 }, 874)).toBe('down');
    expect(keyboardPhase('keyboardDidChangeFrame', undefined, 874)).toBe('down');
    // Cross-fade's zero frame still means the keyboard is up.
    expect(keyboardPhase('keyboardWillChangeFrame', { ...KEYBOARD, screenY: 0 }, 874)).toBe('up');
  });
});

describe('reduceCalibration', () => {
  it('keeps the resting readings and carries them into the keyboard-up phase', () => {
    const resting = reduceCalibration(INITIAL_CALIBRATION_STATE, {
      kind: 'reading',
      reading: { host: { height: 725, atMs: 10 } },
    });
    const up = reduceCalibration(resting, {
      kind: 'keyboard',
      phase: 'up',
      keyboard: { event: 'keyboardWillChangeFrame', ...KEYBOARD, atMs: 50 },
    });
    expect(up.phase).toBe('up');
    expect(up.keyboardAt).toBe(50);
    expect(up.down.host?.height).toBe(725);
    expect(up.up.host?.height).toBe(725);
    const shrunk = reduceCalibration(up, { kind: 'reading', reading: { host: { height: 466, atMs: 80 } } });
    expect(shrunk.up.host?.height).toBe(466);
    expect(shrunk.down.host?.height).toBe(725);
  });
});

describe('SheetKeyboardCalibration', () => {
  let info: MockInstance<typeof console.info>;
  beforeEach(() => {
    vi.useFakeTimers();
    native.listeners.clear();
    native.removed = [];
    probe.onFrame = undefined;
    probe.mounts = 0;
    resetSheetKeyboardCalibrationForTests();
    info = vi.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(() => {
    info.mockRestore();
    vi.useRealTimers();
  });

  function renderReadout() {
    // The column ref only answers `measureInWindow`: anything else the readout
    // tried on it (setNativeProps, a style write) would throw here.
    const measureInWindow = vi.fn((callback: (x: number, y: number, width: number, height: number) => void) =>
      callback(0, 16, 402, 689),
    );
    const columnRef = { current: { measureInWindow } } as unknown as RefObject<NativeView | null>;
    const view = render(
      <SheetKeyboardCalibration label="ModalSheet" columnRef={columnRef} keyboardOverlap={167} bottomInset={0} />,
    );
    return { ...view, measureInWindow };
  }

  it('shows the raw numbers for keyboard down and up, and logs each one', () => {
    publishSheetKeyboardCalibration({ enabled: true, windowTopInset: 62 });
    const { getByTestId, measureInWindow } = renderReadout();
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(measureInWindow).toHaveBeenCalled();
    act(() => probe.onFrame?.({ x: 0, y: 165, width: 1, height: 1 }));
    const readout = () => getByTestId('sheet-keyboard-calibration-readout').textContent ?? '';
    expect(readout()).toContain('safe top root 62 local 0');
    expect(readout()).toContain('padding now 167 inset 0');
    expect(readout()).toContain('DOWN keyboard —');
    expect(readout()).toContain('.global y 165');
    expect(readout()).toContain('column y 16 h 689 bottom 705');

    act(() => native.listeners.get('keyboardWillChangeFrame')?.({ endCoordinates: KEYBOARD }));
    act(() => {
      vi.advanceTimersByTime(1200);
    });
    act(() => probe.onFrame?.({ x: 0, y: 72, width: 1, height: 1 }));
    act(() => getByTestId('sheet-keyboard-calibration-host').click());
    expect(readout()).toContain('UP keyboard top 538 h 336 w 402 keyboardWillChangeFrame @+0ms');
    expect(readout()).toContain('.global y 72');
    expect(readout()).toContain('host h 802');
    expect(readout()).toContain('UP padding by design: .global 239 · K -97 · F 239');

    const logged = info.mock.calls.filter(([tag]) => tag === CALIBRATION_LOG_TAG).map(([, line]) => String(line));
    expect(logged.some((line) => line.includes('"keyboard"') && line.includes('"screenY":538'))).toBe(true);
    expect(logged.some((line) => line.includes('"globalProbe"') && line.includes('"y":72'))).toBe(true);
  });

  it('remounts the probe on every re-measure so SwiftUI reports a fresh frame', () => {
    // One act per scheduled re-measure, as on a device where they land far
    // apart (one act would batch them into a single re-render).
    const runMeasurements = () => {
      let previous = 0;
      for (const delay of CALIBRATION_MEASURE_DELAYS_MS) {
        act(() => {
          vi.advanceTimersByTime(delay - previous);
        });
        previous = delay;
      }
    };
    renderReadout();
    runMeasurements();
    const afterMount = probe.mounts;
    // The first mount plus one remount per scheduled re-measure.
    expect(afterMount).toBe(1 + CALIBRATION_MEASURE_DELAYS_MS.length);
    act(() => native.listeners.get('keyboardDidShow')?.({ endCoordinates: KEYBOARD }));
    runMeasurements();
    expect(probe.mounts).toBe(afterMount + CALIBRATION_MEASURE_DELAYS_MS.length);
  });

  it('stops listening and measuring once unmounted', () => {
    const { unmount, measureInWindow } = renderReadout();
    expect(native.listeners.size).toBe(6);
    unmount();
    expect(native.listeners.size).toBe(0);
    measureInWindow.mockClear();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(measureInWindow).not.toHaveBeenCalled();
  });
});
