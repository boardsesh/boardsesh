// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// The resolved variant SectionHeader's caption treatment keys on. The bug being
// guarded: uppercasing used to key on Platform.OS, so a Liquid-Glass user on
// Android lost the HIG caps. It now keys on `theme.sectionCaption` (variant).
const ctrl = vi.hoisted(() => ({ variant: 'liquidGlass' as 'liquidGlass' | 'material' }));

// react-native isn't satisfiable under jsdom; stub the surface SectionHeader and
// the colour modules touch. Platform.OS is deliberately 'android' to prove the
// casing no longer depends on the platform.
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
  Platform: { OS: 'android' },
  PlatformColor: (name: string) => name,
}));
vi.mock('../Text', () => ({ Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children) }));
vi.mock('../Icon', () => ({ Icon: () => createElement('i', null) }));
vi.mock('../PressableSurface', () => ({
  PressableSurface: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({
    variant: ctrl.variant,
    brandColors: { primary: '#6D28D9' },
    m3: { onSurfaceVariant: '#49454F' },
    sectionCaption:
      ctrl.variant === 'liquidGlass'
        ? { uppercase: true, opacity: 0.6, letterSpacing: 0.5 }
        : { uppercase: false, opacity: 1, letterSpacing: 0 },
  }),
}));

import { SectionHeader } from '../SectionHeader';

describe('SectionHeader caption casing', () => {
  it('uppercases on Liquid Glass even on Android (was Platform.OS-gated)', () => {
    ctrl.variant = 'liquidGlass';
    const { getByText } = render(createElement(SectionHeader, { title: 'stats summary' }));
    expect(getByText('STATS SUMMARY')).toBeTruthy();
  });

  it('keeps sentence case on Material', () => {
    ctrl.variant = 'material';
    const { getByText } = render(createElement(SectionHeader, { title: 'stats summary' }));
    expect(getByText('stats summary')).toBeTruthy();
  });
});
