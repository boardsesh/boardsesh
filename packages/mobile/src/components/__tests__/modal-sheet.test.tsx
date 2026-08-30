// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, forwardRef, type ReactNode, type Ref } from 'react';

const captures = vi.hoisted(() => ({
  bottomSheetViewUsed: false,
  scrollUsed: false,
  snapPoints: undefined as unknown,
  enableDynamicSizing: undefined as unknown,
  scrollStyle: undefined as unknown,
}));
const platform = vi.hoisted(() => ({ os: 'ios' }));

type ViewMockProps = { children?: ReactNode };

vi.mock('@expo/ui/community/bottom-sheet', () => ({
  BottomSheetModal: forwardRef(
    (
      {
        children,
        snapPoints,
        enableDynamicSizing,
      }: ViewMockProps & { snapPoints?: unknown; enableDynamicSizing?: unknown },
      ref: Ref<unknown>,
    ) => {
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

vi.mock('../../lib/haptics', () => ({ hapticMedium: vi.fn() }));

vi.mock('../../providers/sheet-presentation-provider', () => ({
  useManagedSheet: () => ({
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
  }),
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
});
