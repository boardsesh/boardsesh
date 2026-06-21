// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// FeedSectionLabel used to ignore the variant entirely and uppercase on Platform.OS
// === 'ios'. The two visible bugs this guards: Material-on-iOS wrongly uppercased,
// and Liquid-Glass-on-Android wrongly didn't. Both now key on `theme.sectionCaption`.
const ctrl = vi.hoisted(() => ({ variant: 'liquidGlass' as 'liquidGlass' | 'material' }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
  Platform: { OS: 'android' },
  PlatformColor: (name: string) => name,
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    variant: ctrl.variant,
    sectionCaption:
      ctrl.variant === 'liquidGlass'
        ? { uppercase: true, opacity: 0.6, letterSpacing: 0.5 }
        : { uppercase: false, opacity: 1, letterSpacing: 0 },
  }),
}));

import { FeedSectionLabel } from '../FeedSectionLabel';

describe('FeedSectionLabel caption casing', () => {
  it('uppercases on Liquid Glass even on Android', () => {
    ctrl.variant = 'liquidGlass';
    const { getByText } = render(createElement(FeedSectionLabel, { label: 'Today' }));
    expect(getByText('TODAY')).toBeTruthy();
  });

  it('keeps sentence case on Material (was wrongly uppercased on iOS)', () => {
    ctrl.variant = 'material';
    const { getByText } = render(createElement(FeedSectionLabel, { label: 'Today' }));
    expect(getByText('Today')).toBeTruthy();
  });
});
