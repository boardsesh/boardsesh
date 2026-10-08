// @vitest-environment jsdom
import { useEffect, createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

const native = vi.hoisted(() => ({
  os: 'ios' as 'ios' | 'android',
  announce: vi.fn(),
  announceWithOptions: vi.fn() as ReturnType<typeof vi.fn> | undefined,
}));
vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return native.os;
    },
  },
  AccessibilityInfo: {
    announceForAccessibility: (message: string) => native.announce(message),
    get announceForAccessibilityWithOptions() {
      return native.announceWithOptions;
    },
  },
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

vi.mock('../../hooks/use-bottom-accessory', () => ({
  isBottomAccessoryAvailable: () => false,
  useNativeTabBar: () => false,
}));

vi.mock('../../components/Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }),
}));

vi.mock('../../components/Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));

const haptics = vi.hoisted(() => ({ hapticError: vi.fn(), hapticSuccess: vi.fn() }));
vi.mock('../../lib/haptics', () => haptics);

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

function ToastLauncher({ variant = 'success' }: { variant?: 'success' | 'error' | 'info' }) {
  const { showToast } = useToast();
  useEffect(() => {
    showToast('Saved', variant, 1000);
  }, [showToast, variant]);
  return createElement('div');
}

beforeEach(() => {
  native.os = 'ios';
  native.announce.mockClear();
  native.announceWithOptions = vi.fn();
  haptics.hapticSuccess.mockClear();
  haptics.hapticError.mockClear();
});

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

describe('ToastProvider feedback', () => {
  it('announces each toast to VoiceOver once on iOS, queued behind what it is reading', () => {
    render(
      <ToastProvider>
        <ToastLauncher />
      </ToastProvider>,
    );
    expect(native.announceWithOptions).toHaveBeenCalledTimes(1);
    expect(native.announceWithOptions).toHaveBeenCalledWith('Saved', { queue: true });
    expect(native.announce).not.toHaveBeenCalled();
  });

  it('falls back to the plain announce where the queued form is missing', () => {
    native.announceWithOptions = undefined;
    render(
      <ToastProvider>
        <ToastLauncher />
      </ToastProvider>,
    );
    expect(native.announce).toHaveBeenCalledTimes(1);
    expect(native.announce).toHaveBeenCalledWith('Saved');
  });

  it('leaves Android to the live region, so TalkBack reads it once', () => {
    native.os = 'android';
    render(
      <ToastProvider>
        <ToastLauncher />
      </ToastProvider>,
    );
    expect(native.announce).not.toHaveBeenCalled();
    expect(native.announceWithOptions).not.toHaveBeenCalled();
  });

  it('owns the outcome haptic: success and error buzz once, info stays silent', () => {
    render(
      <ToastProvider>
        <ToastLauncher variant="success" />
        <ToastLauncher variant="error" />
        <ToastLauncher variant="info" />
      </ToastProvider>,
    );
    expect(haptics.hapticSuccess).toHaveBeenCalledTimes(1);
    expect(haptics.hapticError).toHaveBeenCalledTimes(1);
  });
});
