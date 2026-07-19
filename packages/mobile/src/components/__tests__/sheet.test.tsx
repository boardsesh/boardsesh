// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, forwardRef, type ReactNode, type Ref } from 'react';

// Captured across renders so tests can assert what Sheet hands the native sheet:
// the onChange handler, the snap points, whether a footer subtree rendered, the
// scroll body's style (the iOS detent bound), and the footer KeyboardAvoidingView's
// behavior (must be "padding" on BOTH platforms — the Android Compose dialog
// window does not resize for the keyboard).
const captures = vi.hoisted(() => ({
  onChange: null as null | ((index: number) => void),
  snapPoints: undefined as unknown,
  scrollUsed: false,
  bottomSheetViewUsed: false,
  scrollStyle: undefined as unknown,
  kavBehavior: undefined as string | undefined,
}));
const platform = vi.hoisted(() => ({ os: 'ios' }));

type SheetMockProps = {
  children?: ReactNode;
  onChange?: (index: number) => void;
  snapPoints?: unknown;
};
type ViewMockProps = { children?: ReactNode };

// The native Expo drop-in: a passthrough that captures the props Sheet sets.
vi.mock('@expo/ui/community/bottom-sheet', () => ({
  default: forwardRef(({ children, onChange, snapPoints }: SheetMockProps, ref: Ref<unknown>) => {
    captures.onChange = onChange ?? null;
    captures.snapPoints = snapPoints;
    return createElement('div', { 'data-sheet': 'true', ref }, children);
  }),
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
  // Version drives the iOS 26+ card-gap correction in useSheetColumnStyle.
  Platform: {
    get OS() {
      return platform.os;
    },
    Version: '26.1',
    select: (options: { ios?: unknown; android?: unknown }) => options.ios,
  },
  View: ({ children }: ViewMockProps) => createElement('div', null, children),
  KeyboardAvoidingView: ({ children, behavior }: ViewMockProps & { behavior?: string }) => {
    captures.kavBehavior = behavior;
    return createElement('div', { 'data-kav': 'true' }, children);
  },
  // Consumed by useSheetColumnStyle to bound the sheet column to the detent on iOS.
  useWindowDimensions: () => ({ width: 390, height: 844 }),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 34, left: 0, right: 0 }),
}));

const hapticMedium = vi.fn();
vi.mock('../../lib/haptics', () => ({ hapticMedium: () => hapticMedium() }));

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
      snapToIndex: vi.fn(),
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
  captures.scrollUsed = false;
  captures.bottomSheetViewUsed = false;
  captures.scrollStyle = undefined;
  captures.kavBehavior = undefined;
  platform.os = 'ios';
  hapticMedium.mockClear();
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

  it('lifts the footer above the keyboard with padding on both platforms', () => {
    // The Android Compose dialog window does NOT resize for the keyboard
    // (emulator-verified), so the KeyboardAvoidingView must pad unconditionally —
    // a platform-gated `undefined` leaves the footer's input covered on Android.
    render(
      <Sheet footer={<div>save</div>}>
        <div>body</div>
      </Sheet>,
    );
    expect(captures.kavBehavior).toBe('padding');
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

  it('fires a haptic and onChange only when the sheet opens (index >= 0)', () => {
    const onChange = vi.fn();
    render(
      <Sheet onChange={onChange}>
        <div>body</div>
      </Sheet>,
    );

    captures.onChange?.(-1);
    expect(onChange).toHaveBeenLastCalledWith(-1);
    expect(hapticMedium).not.toHaveBeenCalled();

    captures.onChange?.(0);
    expect(onChange).toHaveBeenLastCalledWith(0);
    expect(hapticMedium).toHaveBeenCalledTimes(1);
  });
});
