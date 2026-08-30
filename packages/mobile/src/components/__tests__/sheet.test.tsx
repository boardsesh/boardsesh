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
  enableDynamicSizing: undefined as unknown,
  scrollUsed: false,
  bottomSheetViewUsed: false,
  scrollStyle: undefined as unknown,
  scrollContentStyle: undefined as unknown,
  viewStyle: undefined as unknown,
  kavBehavior: undefined as string | undefined,
}));
const platform = vi.hoisted(() => ({ os: 'ios' }));

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
  View: ({ children, style }: ViewMockProps & { style?: unknown }) => {
    captures.viewStyle = style;
    return createElement('div', null, children);
  },
  KeyboardAvoidingView: ({ children, behavior }: ViewMockProps & { behavior?: string }) => {
    captures.kavBehavior = behavior;
    return createElement('div', { 'data-kav': 'true' }, children);
  },
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
  captures.enableDynamicSizing = undefined;
  captures.scrollUsed = false;
  captures.bottomSheetViewUsed = false;
  captures.scrollStyle = undefined;
  captures.scrollContentStyle = undefined;
  captures.viewStyle = undefined;
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
