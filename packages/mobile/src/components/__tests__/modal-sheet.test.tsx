// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Theme } from '../../providers/theme-provider';

vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (styles: Record<string, unknown>) => styles.ios },
  PlatformColor: (name: string) => name,
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', testID ? { 'data-testid': testID } : null, children),
}));

vi.mock('react-native-screens', () => ({
  FullWindowOverlay: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 0 }),
}));

vi.mock('../../lib/preferences/secure-store-adapter', () => ({
  secureStorePreferences: {
    get: () => Promise.resolve(null),
    set: () => Promise.resolve(),
  },
}));

vi.mock('../../lib/haptics', () => ({
  hapticMedium: () => undefined,
}));

vi.mock('@gorhom/bottom-sheet', async () => {
  const React = await import('react');
  const { ThemeProviderBridge } = await import('../../providers/theme-provider');

  return {
    BottomSheetBackdrop: () => null,
    BottomSheetScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
    BottomSheetView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
    BottomSheetModal: React.forwardRef<
      unknown,
      {
        children?: ReactNode;
        backgroundComponent?: (props: { pointerEvents?: string; style?: unknown }) => ReactNode;
      }
    >(function BottomSheetModalMock({ children, backgroundComponent: Background }, _ref) {
      const background = Background ? <Background pointerEvents="none" style={{}} /> : null;

      return (
        <ThemeProviderBridge theme={null as never}>
          {background}
          {children}
        </ThemeProviderBridge>
      );
    }),
  };
});

vi.mock('../GlassSheetBackground', async () => {
  const { useTheme } = await import('../../providers/theme-provider');

  return {
    GlassSheetBackground: () => {
      const { systemColors } = useTheme();
      return createElement('div', { 'data-testid': 'sheet-background' }, String(systemColors.label));
    },
  };
});

import { ModalSheet } from '../ModalSheet';
import { ThemeProviderBridge, useTheme } from '../../providers/theme-provider';

const testTheme = {
  systemColors: {
    background: '#fff',
    secondaryBackground: '#f7f7f7',
    tertiaryBackground: '#eee',
    groupedBackground: '#fafafa',
    elevatedSurface: '#fff',
    label: '#111',
    secondaryLabel: '#666',
    tertiaryLabel: '#999',
    separator: '#ddd',
    fill: '#eee',
    accent: '#06f',
  },
  sheet: { scrimOpacity: 0.24, corners: {}, handleStyle: {} },
} as unknown as Theme;

function ThemeProbe({ testID }: { testID: string }) {
  const { systemColors } = useTheme();
  return createElement('div', { 'data-testid': testID }, String(systemColors.label));
}

describe('ModalSheet theme bridge', () => {
  it('keeps the app theme available to detached sheet background, body, and footer renders', () => {
    const { getByTestId } = render(
      <ThemeProviderBridge theme={testTheme}>
        <ModalSheet footer={<ThemeProbe testID="sheet-footer" />}>
          <ThemeProbe testID="sheet-body" />
        </ModalSheet>
      </ThemeProviderBridge>,
    );

    expect(getByTestId('sheet-background').textContent).toBe('#111');
    expect(getByTestId('sheet-body').textContent).toBe('#111');
    expect(getByTestId('sheet-footer').textContent).toBe('#111');
  });
});
