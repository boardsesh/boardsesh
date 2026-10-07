// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { createElement, forwardRef, type ReactNode, type Ref } from 'react';

const captures = vi.hoisted(() => ({
  bottomSheetViewUsed: false,
  scrollUsed: false,
  snapPoints: undefined as unknown,
  enableDynamicSizing: undefined as unknown,
  scrollStyle: undefined as unknown,
  onChange: undefined as ((index: number) => void) | undefined,
  managedOptions: undefined as Record<string, unknown> | undefined,
}));
const haptics = vi.hoisted(() => ({ hapticMedium: vi.fn() }));
const platform = vi.hoisted(() => ({ os: 'ios' }));

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
  View: ({ children }: ViewMockProps) => createElement('div', null, children),
  KeyboardAvoidingView: ({ children }: ViewMockProps) => createElement('div', null, children),
  useWindowDimensions: () => ({ width: 390, height: 844 }),
  StyleSheet: {
    create: (styles: Record<string, unknown>) => styles,
    hairlineWidth: 1,
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

vi.mock('../../lib/haptics', () => ({ hapticMedium: haptics.hapticMedium }));

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

import { ModalSheet } from '../ModalSheet';

beforeEach(() => {
  captures.bottomSheetViewUsed = false;
  captures.scrollUsed = false;
  captures.snapPoints = undefined;
  captures.enableDynamicSizing = undefined;
  captures.scrollStyle = undefined;
  captures.onChange = undefined;
  captures.managedOptions = undefined;
  haptics.hapticMedium.mockClear();
  platform.os = 'ios';
});

describe('ModalSheet', () => {
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

  describe('presentHaptic', () => {
    it('fires the haptic when the sheet opens by default', () => {
      render(
        <ModalSheet visible>
          <div>body</div>
        </ModalSheet>,
      );
      act(() => captures.onChange?.(0));
      expect(haptics.hapticMedium).toHaveBeenCalledTimes(1);
    });

    it('stays quiet on open when false, but keeps the haptic for a drag between detents and the next open', () => {
      render(
        <ModalSheet visible presentHaptic={false} snapPoints={['50%', '90%']}>
          <div>body</div>
        </ModalSheet>,
      );
      act(() => captures.onChange?.(0));
      expect(haptics.hapticMedium).not.toHaveBeenCalled();
      act(() => captures.onChange?.(1));
      expect(haptics.hapticMedium).toHaveBeenCalledTimes(1);
      // Closed, then opened again: still no haptic for the open itself.
      act(() => captures.onChange?.(-1));
      act(() => captures.onChange?.(0));
      expect(haptics.hapticMedium).toHaveBeenCalledTimes(1);
    });
  });
});
