// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, forwardRef, type ReactNode, type Ref } from 'react';

const captures = vi.hoisted(() => ({
  bottomSheetViewUsed: false,
  scrollUsed: false,
}));
const platform = vi.hoisted(() => ({ os: 'ios' }));

type ViewMockProps = { children?: ReactNode };

vi.mock('@expo/ui/community/bottom-sheet', () => ({
  BottomSheetModal: forwardRef(({ children }: ViewMockProps, ref: Ref<unknown>) =>
    createElement('div', { 'data-sheet': 'true', ref }, children),
  ),
  BottomSheetScrollView: ({ children }: ViewMockProps) => {
    captures.scrollUsed = true;
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
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
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
});
