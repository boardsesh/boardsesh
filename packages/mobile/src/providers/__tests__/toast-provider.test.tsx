// @vitest-environment jsdom
import { useEffect, createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  PlatformColor: (name: string) => name,
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { absoluteFill: {}, create: (styles: Record<string, unknown>) => styles },
}));

vi.mock('react-native-reanimated', () => ({
  default: { View: ({ children }: { children?: ReactNode }) => createElement('div', null, children) },
  FadeIn: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 34, left: 0, right: 0, top: 0 }),
}));

vi.mock('expo-router', () => ({
  useSegments: () => ['(tabs)', 'climbs'],
}));

vi.mock('../../components/Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }),
}));

vi.mock('../../components/Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));

vi.mock('../../lib/haptics', () => ({
  hapticError: vi.fn(),
  hapticSuccess: vi.fn(),
}));

vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({
    // createVariantComponent indexes impls[variant]; the old ternary tolerated an
    // absent variant (fell through to the glass path), so pin it explicitly.
    variant: 'liquidGlass',
    colorScheme: 'light',
    brandColors: { success: '#047857', error: '#C81E1E', primary: '#6D28D9', warning: '#B45309' },
    systemColors: { secondaryBackground: '#fff' },
  }),
}));

import { ToastProvider, useToast } from '../toast-provider';

function ToastLauncher() {
  const { showToast } = useToast();
  useEffect(() => {
    showToast('Saved', 'success', 1000);
  }, [showToast]);
  return createElement('div');
}

describe('ToastProvider', () => {
  it('can render toasts without a QueueProvider ancestor', () => {
    const { container } = render(
      <ToastProvider>
        <ToastLauncher />
      </ToastProvider>,
    );

    expect(container.textContent).toContain('Saved');
  });
});
