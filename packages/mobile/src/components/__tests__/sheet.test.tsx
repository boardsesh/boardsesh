// @vitest-environment jsdom
vi.mock('../use-ios-sheet-background-style', () => ({ useIosSheetBackgroundStyle: () => undefined }));
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { createElement, forwardRef, type ReactNode, type Ref } from 'react';

// Captured across renders so tests can assert what Sheet hands the native sheet:
// the onChange handler, the snap points, whether a footer subtree rendered, the
// scroll body's style (the iOS detent bound), and the chrome column's and footer's
// bottom padding as the keyboard comes and goes (padded on BOTH platforms — the
// Android Compose dialog window does not resize for the keyboard).
const captures = vi.hoisted(() => ({
  onChange: null as null | ((index: number) => void),
  snapPoints: undefined as unknown,
  enableDynamicSizing: undefined as unknown,
  scrollUsed: false,
  bottomSheetViewUsed: false,
  scrollStyle: undefined as unknown,
  scrollContentStyle: undefined as unknown,
  viewStyle: undefined as unknown,
  viewStyles: [] as unknown[],
  columnStyle: undefined as unknown,
}));
const platform = vi.hoisted(() => ({ os: 'ios' }));
type KeyboardListener = (event: {
  endCoordinates?: { height: number; screenY: number; width: number };
  duration?: number;
}) => void;
const keyboard = vi.hoisted(() => ({ listeners: new Map<string, KeyboardListener>() }));
const snapToIndex = vi.hoisted(() => vi.fn());
// The column's window frame: bottom at the 844pt window's bottom edge.
const columnMeasure = vi.hoisted(() =>
  vi.fn((callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 244, 390, 600)),
);

// Faithful recursive flatten (nested arrays merge left-to-right) so the tests read
// the effective style the way React Native would, not just a one-level Object.assign.
function flattenStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flattenStyle));
  if (style && typeof style === 'object') return style as Record<string, unknown>;
  return {};
}

type SheetMockProps = {
  children?: ReactNode;
  onChange?: (index: number) => void;
  snapPoints?: unknown;
  enableDynamicSizing?: unknown;
};
type ViewMockProps = { children?: ReactNode };

// The native Expo drop-in: a passthrough that captures the props Sheet sets.
vi.mock('@expo/ui/community/bottom-sheet', () => ({
  default: forwardRef(({ children, onChange, snapPoints, enableDynamicSizing }: SheetMockProps, ref: Ref<unknown>) => {
    captures.onChange = onChange ?? null;
    captures.snapPoints = snapPoints;
    captures.enableDynamicSizing = enableDynamicSizing;
    return createElement('div', { 'data-sheet': 'true', ref }, children);
  }),
  BottomSheetScrollView: ({
    children,
    style,
    contentContainerStyle,
  }: ViewMockProps & { style?: unknown; contentContainerStyle?: unknown }) => {
    captures.scrollUsed = true;
    captures.scrollStyle = style;
    captures.scrollContentStyle = contentContainerStyle;
    return createElement('div', { 'data-scroll': 'true' }, children);
  },
  BottomSheetView: ({ children }: ViewMockProps) => {
    captures.bottomSheetViewUsed = true;
    return createElement('div', { 'data-bottom-sheet-view': 'true' }, children);
  },
}));

vi.mock('react-native', () => ({
  // Version drives the iOS 26+ card-gap correction in useSheetColumnStyle.
  Platform: {
    get OS() {
      return platform.os;
    },
    Version: '26.1',
    select: (options: { ios?: unknown; android?: unknown }) => options.ios,
  },
  View: ({
    children,
    style,
    testID,
    ref,
  }: ViewMockProps & { style?: unknown; testID?: string; ref?: { current: unknown } }) => {
    captures.viewStyle = style;
    captures.viewStyles.push(style);
    if (testID === 'sheet-chrome-column') {
      captures.columnStyle = style;
      // React 19 hands a function component its ref as a prop.
      if (ref) ref.current = { measureInWindow: columnMeasure };
    }
    return createElement('div', null, children);
  },
  Keyboard: {
    addListener: (eventName: string, listener: KeyboardListener) => {
      keyboard.listeners.set(eventName, listener);
      return { remove: () => keyboard.listeners.delete(eventName) };
    },
    isVisible: () => false,
    metrics: () => undefined,
  },
  LayoutAnimation: { configureNext: () => {} },
  // Consumed by useSheetColumnStyle to bound the sheet column to the detent on iOS.
  useWindowDimensions: () => ({ width: 390, height: 844 }),
  StyleSheet: {
    create: (styles: Record<string, unknown>) => styles,
    hairlineWidth: 1,
    // Consumed by the #3922 detent probe (sheet-detent-probe.ts).
    absoluteFill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
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

const hapticSelection = vi.fn();
vi.mock('../../lib/haptics', () => ({ hapticSelection: () => hapticSelection() }));

// Isolate the wrapper from the coordinator: useManagedSheet's serialization is
// covered by sheet-presentation-provider.test.tsx. Here we only assert the
// wrapper's own chrome (footer/scroll/snap points/haptics + consumer onChange).
vi.mock('../../providers/sheet-presentation-provider', () => ({
  useManagedSheet: () => ({
    onChange: () => {},
    onFullyDismissed: () => {},
    // Stub the full handle (not {}) so a future test calling ref.current.present()
    // gets a spy, not a silent undefined-is-not-a-function throw.
    handle: {
      present: vi.fn(),
      dismiss: vi.fn(),
      close: vi.fn(),
      forceClose: vi.fn(),
      snapToIndex,
      snapToPosition: vi.fn(),
      expand: vi.fn(),
      collapse: vi.fn(),
    },
  }),
}));

vi.mock('../../theme/tokens', () => ({
  spacing: { 2: 8, 3: 12, 4: 16, 6: 24 },
}));

vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { secondaryBackground: '#fff', separator: '#ccc' },
    sheet: { handleStyle: {} },
  }),
}));

import { Sheet } from '../Sheet';

beforeEach(() => {
  captures.onChange = null;
  captures.snapPoints = undefined;
  captures.enableDynamicSizing = undefined;
  captures.scrollUsed = false;
  captures.bottomSheetViewUsed = false;
  captures.scrollStyle = undefined;
  captures.scrollContentStyle = undefined;
  captures.viewStyle = undefined;
  captures.viewStyles = [];
  captures.columnStyle = undefined;
  keyboard.listeners.clear();
  snapToIndex.mockClear();
  columnMeasure.mockClear();
  platform.os = 'ios';
  hapticSelection.mockClear();
});

describe('Sheet', () => {
  it('renders a footer subtree below the content when a footer is provided', () => {
    const { getByTestId } = render(
      <Sheet footer={<div data-testid="footer">save</div>}>
        <div data-testid="body">body</div>
      </Sheet>,
    );
    expect(getByTestId('footer')).toBeTruthy();
    expect(getByTestId('body')).toBeTruthy();
  });

  it('renders no footer subtree when no footer is provided', () => {
    const { queryByTestId } = render(
      <Sheet>
        <div data-testid="body">body</div>
      </Sheet>,
    );
    expect(queryByTestId('footer')).toBeNull();
  });

  it('uses a scroll container only when scrollable', () => {
    render(
      <Sheet scrollable>
        <div>body</div>
      </Sheet>,
    );
    expect(captures.scrollUsed).toBe(true);
  });

  it('keeps footerless native dynamic content in the existing plain View layout', () => {
    render(
      <Sheet enableDynamicSizing>
        <div>body</div>
      </Sheet>,
    );
    expect(captures.bottomSheetViewUsed).toBe(false);
  });

  it('uses BottomSheetView to measure footerless dynamic content on web', () => {
    platform.os = 'web';
    render(
      <Sheet enableDynamicSizing>
        <div>body</div>
      </Sheet>,
    );
    expect(captures.bottomSheetViewUsed).toBe(true);
  });

  it('keeps fixed-size and footer content in the existing plain View layout', () => {
    const fixedSheet = render(
      <Sheet>
        <div>fixed body</div>
      </Sheet>,
    );
    expect(captures.bottomSheetViewUsed).toBe(false);

    fixedSheet.unmount();
    render(
      <Sheet enableDynamicSizing footer={<div>save</div>}>
        <div>footer body</div>
      </Sheet>,
    );
    expect(captures.bottomSheetViewUsed).toBe(false);
  });

  it('defaults snap points when none are provided', () => {
    render(
      <Sheet>
        <div>body</div>
      </Sheet>,
    );
    expect(captures.snapPoints).toEqual(['50%', '90%']);
  });

  describe('keyboard', () => {
    // An 844pt-tall, 390pt-wide window (the react-native mock).
    const IOS_KEYBOARD = { height: 336, screenY: 844 - 336, width: 390 };
    // The footer bar is the one View with a hairline top border.
    const footerPadding = () =>
      captures.viewStyles
        .map(flattenStyle)
        .filter((style) => style.borderTopWidth !== undefined)
        .at(-1)?.paddingBottom;
    const columnPadding = () => flattenStyle(captures.columnStyle).paddingBottom;
    // Opened the way the native sheet reports it: onChange with a detent index.
    const renderOpenFooterSheet = (snapPoints?: string[], openAt = 1) => {
      const utils = render(
        <Sheet scrollable snapPoints={snapPoints} footer={<div>send</div>}>
          <div>body</div>
        </Sheet>,
      );
      act(() => captures.onChange?.(openAt));
      return utils;
    };

    it('rests the footer on the window inset while the keyboard is down', () => {
      renderOpenFooterSheet();
      expect(columnPadding()).toBeUndefined();
      expect(footerPadding()).toBe(34 + 12);
    });

    it('pads the column by the keyboard and swaps the inset out of the footer on iOS', () => {
      renderOpenFooterSheet();
      act(() => keyboard.listeners.get('keyboardWillChangeFrame')?.({ endCoordinates: IOS_KEYBOARD, duration: 250 }));
      expect(columnPadding()).toBe(336);
      expect(footerPadding()).toBe(12);
      act(() =>
        keyboard.listeners.get('keyboardWillHide')?.({
          endCoordinates: { ...IOS_KEYBOARD, screenY: 844 },
          duration: 250,
        }),
      );
      expect(columnPadding()).toBeUndefined();
      expect(footerPadding()).toBe(34 + 12);
    });

    it('does not listen while the sheet is closed, and lets go when it closes', () => {
      render(
        <Sheet scrollable footer={<div>send</div>}>
          <div>body</div>
        </Sheet>,
      );
      expect(keyboard.listeners.size).toBe(0);
      act(() => captures.onChange?.(0));
      expect(keyboard.listeners.size).toBeGreaterThan(0);
      act(() => captures.onChange?.(-1));
      expect(keyboard.listeners.size).toBe(0);
    });

    it('raises a short detent to the keyboard detent without the drag haptic', () => {
      // FeedbackSheet's 44% detent: the keyboard would leave its body 0pt.
      renderOpenFooterSheet(['44%', '90%'], 0);
      hapticSelection.mockClear();
      act(() => keyboard.listeners.get('keyboardWillChangeFrame')?.({ endCoordinates: IOS_KEYBOARD, duration: 250 }));
      expect(snapToIndex).toHaveBeenCalledWith(1);
      expect(hapticSelection).not.toHaveBeenCalled();
      // The same keyboard reporting a new frame (QuickType bar) is not a new show.
      act(() =>
        keyboard.listeners.get('keyboardWillChangeFrame')?.({
          endCoordinates: { ...IOS_KEYBOARD, height: 380, screenY: 844 - 380 },
          duration: 250,
        }),
      );
      expect(snapToIndex).toHaveBeenCalledTimes(1);
    });

    it('re-measures the column once a detent change has settled with the keyboard up', () => {
      vi.useFakeTimers();
      try {
        renderOpenFooterSheet(['44%', '90%'], 0);
        act(() => keyboard.listeners.get('keyboardWillChangeFrame')?.({ endCoordinates: IOS_KEYBOARD, duration: 250 }));
        // The raise lands as the native onChange; the sheet then animates.
        act(() => captures.onChange?.(1));
        columnMeasure.mockClear();
        act(() => {
          vi.advanceTimersByTime(299);
        });
        expect(columnMeasure).not.toHaveBeenCalled();
        act(() => {
          vi.advanceTimersByTime(1);
        });
        expect(columnMeasure).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not re-measure after a detent change with the keyboard down', () => {
      vi.useFakeTimers();
      try {
        renderOpenFooterSheet(['44%', '90%'], 0);
        act(() => captures.onChange?.(1));
        columnMeasure.mockClear();
        act(() => {
          vi.advanceTimersByTime(1000);
        });
        expect(columnMeasure).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('leaves a sheet already at its keyboard detent where it is', () => {
      renderOpenFooterSheet(['44%', '90%'], 1);
      act(() => keyboard.listeners.get('keyboardWillChangeFrame')?.({ endCoordinates: IOS_KEYBOARD, duration: 250 }));
      expect(snapToIndex).not.toHaveBeenCalled();
    });

    it('leaves a chrome-less sheet off the keyboard listeners, on its resting inset', () => {
      render(
        <Sheet scrollable contentContainerStyle={{ paddingBottom: 8 }}>
          <div>body</div>
        </Sheet>,
      );
      act(() => captures.onChange?.(0));
      expect(keyboard.listeners.size).toBe(0);
      expect(flattenStyle(captures.scrollContentStyle).paddingBottom).toBe(8 + 34);
    });

    it('pads the column by keyboard + nav bar on Android, where the IME height excludes it', () => {
      // The Android Compose dialog window does NOT resize for the keyboard
      // (emulator-verified), so the column must pad on Android too.
      platform.os = 'android';
      renderOpenFooterSheet();
      act(() =>
        keyboard.listeners.get('keyboardDidShow')?.({ endCoordinates: { height: 280, screenY: 530, width: 390 } }),
      );
      expect(columnPadding()).toBe(280 + 34);
      expect(footerPadding()).toBe(12);
    });
  });

  it('bounds a footerless scrollable body to the detent height on iOS (#3330)', () => {
    // Without a footer the body itself is the sheet's single child, so it must
    // carry the iOS detent bound directly — a flex:1 body sizes to content under
    // SwiftUI's unbounded proposal and clips anything past the detent. Default
    // snap points ['50%','90%'] at index 0 on an 844pt window with a 0 top inset:
    // round((844 − 24pt card gap) * 0.5) − 20pt top chrome = 390.
    render(
      <Sheet scrollable>
        <div>body</div>
      </Sheet>,
    );
    expect(captures.scrollStyle).toEqual({ height: 390 });
  });

  it('pads a footerless scrollable body for the bottom safe-area inset (Android nav bar clearance)', () => {
    // No footer means the body sits against the bottom edge, so it must clear the
    // system nav bar itself — the native sheet does not pad content for it. Inset
    // is 34 in this file's safe-area mock.
    render(
      <Sheet scrollable contentContainerStyle={{ paddingBottom: 8 }}>
        <div>body</div>
      </Sheet>,
    );
    // Consumer's 8 is preserved and the 34 inset is added on top.
    expect(flattenStyle(captures.scrollContentStyle).paddingBottom).toBe(42);
  });

  it('pads a footerless non-scrollable body for the bottom safe-area inset', () => {
    // The non-scrollable branch renders the body in a plain View that also gets the
    // composed contentContainerStyle, so it must clear the nav bar the same way.
    render(
      <Sheet contentContainerStyle={{ paddingBottom: 8 }}>
        <div>body</div>
      </Sheet>,
    );
    expect(flattenStyle(captures.viewStyle).paddingBottom).toBe(42);
  });

  describe('androidContentSized', () => {
    it('drops the snap points for the content-fitting path on Android (#4720)', () => {
      platform.os = 'android';
      render(
        <Sheet androidContentSized snapPoints={['80%', '92%']} scrollable footer={<div>save</div>}>
          <div>body</div>
        </Sheet>,
      );
      expect(captures.snapPoints).toBeUndefined();
      expect(captures.enableDynamicSizing).toBe(true);
    });

    it('lets the scroll body shrink-to-scroll instead of flex-filling on that path', () => {
      platform.os = 'android';
      render(
        <Sheet androidContentSized snapPoints={['80%', '92%']} scrollable footer={<div>save</div>}>
          <div>body</div>
        </Sheet>,
      );
      expect(flattenStyle(captures.scrollStyle)).toEqual({ flexShrink: 1 });
    });

    it('keeps the exact detents on iOS regardless of the flag', () => {
      render(
        <Sheet androidContentSized snapPoints={['80%', '92%']} scrollable footer={<div>save</div>}>
          <div>body</div>
        </Sheet>,
      );
      expect(captures.snapPoints).toEqual(['80%', '92%']);
      expect(captures.enableDynamicSizing).toBe(false);
    });
  });

  it('forwards every onChange, and stays silent when the sheet presents', () => {
    const onChange = vi.fn();
    render(
      <Sheet onChange={onChange}>
        <div>body</div>
      </Sheet>,
    );

    captures.onChange?.(-1);
    expect(onChange).toHaveBeenLastCalledWith(-1);

    // The present is the result of a tap that already gave feedback (HIG:
    // haptics match the person's own action, sparingly).
    captures.onChange?.(0);
    expect(onChange).toHaveBeenLastCalledWith(0);
    expect(hapticSelection).not.toHaveBeenCalled();
  });

  it('ticks once per drag between detents, never for a re-report of the same detent', () => {
    render(
      <Sheet snapPoints={['50%', '90%']}>
        <div>body</div>
      </Sheet>,
    );
    captures.onChange?.(0);
    captures.onChange?.(1);
    expect(hapticSelection).toHaveBeenCalledTimes(1);
    captures.onChange?.(1);
    expect(hapticSelection).toHaveBeenCalledTimes(1);
    captures.onChange?.(0);
    expect(hapticSelection).toHaveBeenCalledTimes(2);
    // Closed, then presented again: the present stays silent.
    captures.onChange?.(-1);
    captures.onChange?.(0);
    expect(hapticSelection).toHaveBeenCalledTimes(2);
  });
});
