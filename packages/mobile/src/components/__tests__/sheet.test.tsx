// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, forwardRef, type ReactNode, type Ref } from 'react';

// Captured across renders so tests can assert what Sheet hands the native sheet:
// the onChange handler, the snap points, and whether a footer subtree rendered.
const captures = vi.hoisted(() => ({
  onChange: null as null | ((index: number) => void),
  snapPoints: undefined as unknown,
  scrollUsed: false,
}));

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
  BottomSheetScrollView: ({ children }: ViewMockProps) => {
    captures.scrollUsed = true;
    return createElement('div', { 'data-scroll': 'true' }, children);
  },
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (options: { ios?: unknown; android?: unknown }) => options.ios },
  View: ({ children }: ViewMockProps) => createElement('div', null, children),
  KeyboardAvoidingView: ({ children }: ViewMockProps) => createElement('div', { 'data-kav': 'true' }, children),
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

  it('defaults snap points when none are provided', () => {
    render(
      <Sheet>
        <div>body</div>
      </Sheet>,
    );
    expect(captures.snapPoints).toEqual(['50%', '90%']);
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
