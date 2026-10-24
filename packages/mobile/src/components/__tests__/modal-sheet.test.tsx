// @vitest-environment jsdom
vi.mock('../use-ios-sheet-background-style', () => ({ useIosSheetBackgroundStyle: () => undefined }));
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { createElement, forwardRef, type ReactNode, type Ref } from 'react';
import type { LayoutChangeEvent } from 'react-native';

const captures = vi.hoisted(() => ({
  bottomSheetViewUsed: false,
  scrollUsed: false,
  snapPoints: undefined as unknown,
  enableDynamicSizing: undefined as unknown,
  scrollStyle: undefined as unknown,
  onChange: undefined as ((index: number) => void) | undefined,
  managedOptions: undefined as Record<string, unknown> | undefined,
  columnStyle: undefined as unknown,
  onHostLayout: undefined as ((event: LayoutChangeEvent) => void) | undefined,
}));
const haptics = vi.hoisted(() => ({ hapticSelection: vi.fn() }));
const platform = vi.hoisted(() => ({ os: 'ios' }));
type KeyboardListener = (event: {
  endCoordinates?: { height: number; screenY: number; width: number };
  duration?: number;
}) => void;
const keyboardListeners = vi.hoisted(() => new Map<string, KeyboardListener>());

type ViewMockProps = { children?: ReactNode };

vi.mock('@expo/ui/community/bottom-sheet', () => ({
  BottomSheetModal: forwardRef(
    (
      {
        children,
        snapPoints,
        enableDynamicSizing,
        onChange,
      }: ViewMockProps & { snapPoints?: unknown; enableDynamicSizing?: unknown; onChange?: (index: number) => void },
      ref: Ref<unknown>,
    ) => {
      captures.onChange = onChange;
      captures.snapPoints = snapPoints;
      captures.enableDynamicSizing = enableDynamicSizing;
      return createElement('div', { 'data-sheet': 'true', ref }, children);
    },
  ),
  BottomSheetScrollView: ({ children, style }: ViewMockProps & { style?: unknown }) => {
    captures.scrollUsed = true;
    captures.scrollStyle = style;
    return createElement('div', { 'data-scroll': 'true' }, children);
  },
  BottomSheetView: ({ children }: ViewMockProps) => {
    captures.bottomSheetViewUsed = true;
    return createElement('div', { 'data-bottom-sheet-view': 'true' }, children);
  },
}));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return platform.os;
    },
    Version: '26.1',
    select: (options: { ios?: unknown }) => options.ios,
  },
  View: ({
    children,
    style,
    testID,
    ref,
    onLayout,
  }: ViewMockProps & {
    style?: unknown;
    testID?: string;
    ref?: { current: unknown };
    onLayout?: (event: LayoutChangeEvent) => void;
  }) => {
    if (testID === 'sheet-keyboard-host') captures.onHostLayout = onLayout;
    if (testID === 'sheet-chrome-column') {
      captures.columnStyle = style;
      if (ref)
        ref.current = {
          measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) =>
            callback(0, 16, 390, Number(flattenStyle(style).height)),
        };
    }
    return createElement('div', null, children);
  },
  Keyboard: {
    addListener: (eventName: string, listener: KeyboardListener) => {
      keyboardListeners.set(eventName, listener);
      return { remove: () => keyboardListeners.delete(eventName) };
    },
    isVisible: () => false,
    metrics: () => undefined,
  },
  LayoutAnimation: { configureNext: () => {} },
  useWindowDimensions: () => ({ width: 390, height: 844 }),
  StyleSheet: {
    create: (styles: Record<string, unknown>) => styles,
    hairlineWidth: 1,
    absoluteFill: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
    // Faithful flatten (arrays merge left-to-right, falsy entries skipped) — the
    // footerless body composes its bottom inset through withSheetBottomInset.
    flatten: function flatten(style: unknown): Record<string, unknown> | undefined {
      if (style == null || style === false) return undefined;
      if (Array.isArray(style)) {
        const out: Record<string, unknown> = {};
        for (const entry of style) {
          const flat = flatten(entry);
          if (flat) Object.assign(out, flat);
        }
        return out;
      }
      return style as Record<string, unknown>;
    },
  },
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 34, left: 0, right: 0 }),
}));

vi.mock('../../lib/haptics', () => ({ hapticSelection: haptics.hapticSelection }));

vi.mock('../../providers/sheet-presentation-provider', () => ({
  useManagedSheet: (options: Record<string, unknown>) => {
    captures.managedOptions = options;
    return {
      onChange: vi.fn(),
      onFullyDismissed: vi.fn(),
      handle: {
        present: vi.fn(),
        dismiss: vi.fn(),
        close: vi.fn(),
        forceClose: vi.fn(),
        snapToIndex: vi.fn(),
        snapToPosition: vi.fn(),
        expand: vi.fn(),
        collapse: vi.fn(),
      },
    };
  },
}));

vi.mock('../../theme/tokens', () => ({
  spacing: { 3: 12, 4: 16 },
}));

vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { secondaryBackground: '#fff', separator: '#ccc' },
    sheet: { handleStyle: {} },
  }),
}));

// The #5964 calibration readout, captured rather than rendered: its own suite
// (sheet-keyboard-calibration.test.tsx) covers what it draws.
const calibration = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));
vi.mock('../sheet-keyboard-calibration', () => ({
  SheetKeyboardCalibration: (props: Record<string, unknown>) => {
    calibration.props.push(props);
    return null;
  },
}));

import { ModalSheet } from '../ModalSheet';
import {
  publishSheetKeyboardCalibration,
  resetSheetKeyboardCalibrationForTests,
} from '../../lib/sheet-keyboard-calibration-store';

beforeEach(() => {
  calibration.props = [];
  resetSheetKeyboardCalibrationForTests();
  captures.bottomSheetViewUsed = false;
  captures.scrollUsed = false;
  captures.snapPoints = undefined;
  captures.enableDynamicSizing = undefined;
  captures.scrollStyle = undefined;
  captures.onChange = undefined;
  captures.managedOptions = undefined;
  captures.columnStyle = undefined;
  captures.onHostLayout = undefined;
  keyboardListeners.clear();
  haptics.hapticSelection.mockClear();
  platform.os = 'ios';
});

function flattenStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flattenStyle));
  return style && typeof style === 'object' ? (style as Record<string, unknown>) : {};
}

function reportHostHeight(height: number): void {
  expect(captures.onHostLayout).toBeTypeOf('function');
  act(() =>
    captures.onHostLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height } } } as LayoutChangeEvent),
  );
}

describe('ModalSheet', () => {
  it('lifts its chrome when the native host shrinks after the keyboard event', () => {
    render(
      <ModalSheet visible scrollable footer={<div>save</div>}>
        <div>body</div>
      </ModalSheet>,
    );
    act(() => captures.onChange?.(1));
    expect(flattenStyle(captures.columnStyle).height).toBe(718);
    reportHostHeight(734);
    act(() =>
      keyboardListeners.get('keyboardWillChangeFrame')?.({
        endCoordinates: { height: 336, screenY: 508, width: 390 },
        duration: 250,
      }),
    );
    expect(flattenStyle(captures.columnStyle).paddingBottom).toBeUndefined();
    reportHostHeight(398);
    expect(flattenStyle(captures.columnStyle).paddingBottom).toBe(336);
    act(() =>
      keyboardListeners.get('keyboardWillHide')?.({
        endCoordinates: { height: 336, screenY: 844, width: 390 },
        duration: 250,
      }),
    );
    expect(flattenStyle(captures.columnStyle).paddingBottom).toBeUndefined();
  });

  it('keeps footerless native dynamic content in the existing plain View layout', () => {
    render(
      <ModalSheet enableDynamicSizing>
        <div>body</div>
      </ModalSheet>,
    );

    expect(captures.bottomSheetViewUsed).toBe(false);
    expect(captures.scrollUsed).toBe(false);
  });

  it('uses BottomSheetView to measure footerless dynamic content on web', () => {
    platform.os = 'web';
    render(
      <ModalSheet enableDynamicSizing>
        <div>body</div>
      </ModalSheet>,
    );

    expect(captures.bottomSheetViewUsed).toBe(true);
    expect(captures.scrollUsed).toBe(false);
  });

  it('keeps fixed-size and footer content in the existing plain View layout', () => {
    const fixedSheet = render(
      <ModalSheet>
        <div>fixed body</div>
      </ModalSheet>,
    );
    expect(captures.bottomSheetViewUsed).toBe(false);

    fixedSheet.unmount();
    render(
      <ModalSheet enableDynamicSizing footer={<div>save</div>}>
        <div>footer body</div>
      </ModalSheet>,
    );
    expect(captures.bottomSheetViewUsed).toBe(false);
  });

  describe('androidContentSized (#4720)', () => {
    it('drops the snap points for the content-fitting path on Android', () => {
      platform.os = 'android';
      render(
        <ModalSheet androidContentSized snapPoints={['65%', '92%']} scrollable footer={<div>save</div>}>
          <div>body</div>
        </ModalSheet>,
      );
      expect(captures.snapPoints).toBeUndefined();
      expect(captures.enableDynamicSizing).toBe(true);
      expect(captures.scrollStyle).toEqual({ flexShrink: 1 });
    });

    it('keeps the exact detents on iOS regardless of the flag', () => {
      render(
        <ModalSheet androidContentSized snapPoints={['65%', '92%']} scrollable footer={<div>save</div>}>
          <div>body</div>
        </ModalSheet>,
      );
      expect(captures.snapPoints).toEqual(['65%', '92%']);
      expect(captures.enableDynamicSizing).toBe(false);
    });
  });

  // #5964: the QA calibration readout exists only while its flag is on, and only
  // on a sheet with a column to measure.
  describe('keyboard calibration readout', () => {
    it('is not mounted while the flag is off', () => {
      render(
        <ModalSheet visible scrollable footer={<div>save</div>}>
          <div>body</div>
        </ModalSheet>,
      );
      expect(calibration.props).toHaveLength(0);
    });

    it('measures the chrome column once the flag is on, with the padding it applies today', () => {
      publishSheetKeyboardCalibration({ enabled: true, windowTopInset: 62 });
      render(
        <ModalSheet visible scrollable footer={<div>save</div>}>
          <div>body</div>
        </ModalSheet>,
      );
      const latest = calibration.props.at(-1);
      expect(latest?.label).toBe('ModalSheet');
      expect(latest?.columnRef).toHaveProperty('current');
      expect(latest?.keyboardOverlap).toBe(0);
      expect(latest?.bottomInset).toBe(34);
    });

    it('is not mounted on a sheet without a header or footer', () => {
      publishSheetKeyboardCalibration({ enabled: true, windowTopInset: 62 });
      render(
        <ModalSheet visible>
          <div>body</div>
        </ModalSheet>,
      );
      expect(calibration.props).toHaveLength(0);
    });
  });

  it('forwards onDisplaced to the coordinator, apart from onClose', () => {
    const onClose = vi.fn();
    const onDisplaced = vi.fn();
    render(
      <ModalSheet visible onClose={onClose} onDisplaced={onDisplaced}>
        <div>body</div>
      </ModalSheet>,
    );
    expect(captures.managedOptions?.onDisplaced).toBe(onDisplaced);
    expect(captures.managedOptions?.onClose).toBe(onClose);
  });

  describe('detent haptic', () => {
    it('stays silent when the sheet presents', () => {
      render(
        <ModalSheet visible>
          <div>body</div>
        </ModalSheet>,
      );
      act(() => captures.onChange?.(0));
      expect(haptics.hapticSelection).not.toHaveBeenCalled();
    });

    it('ticks a selection for a drag between detents, and stays silent on the next present', () => {
      render(
        <ModalSheet visible snapPoints={['50%', '90%']}>
          <div>body</div>
        </ModalSheet>,
      );
      act(() => captures.onChange?.(0));
      act(() => captures.onChange?.(1));
      expect(haptics.hapticSelection).toHaveBeenCalledTimes(1);
      act(() => captures.onChange?.(-1));
      act(() => captures.onChange?.(0));
      expect(haptics.hapticSelection).toHaveBeenCalledTimes(1);
    });
  });
});
