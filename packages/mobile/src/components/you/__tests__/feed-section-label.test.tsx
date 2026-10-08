// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// FeedSectionLabel keys on `theme.sectionCaption` (variant, not Platform.OS).
// Both variants are sentence case in secondaryLabel now (HIG Lists and tables);
// the old Liquid Glass caption uppercased, dimmed and tracked out.
const ctrl = vi.hoisted(() => ({ variant: 'liquidGlass' as 'liquidGlass' | 'material' }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
  Platform: { OS: 'android' },
  PlatformColor: (name: string) => name,
}));
vi.mock('../../Text', () => ({
  Text: ({ children, color }: { children?: ReactNode; color?: string }) =>
    createElement('span', { 'data-color': color }, children),
}));
vi.mock('../../../providers/theme-provider', async () => {
  const { sectionCaptionByVariant } = await import('../../../theme/variants/variant-tokens');
  return {
    useTheme: () => ({
      variant: ctrl.variant,
      systemColors: { secondaryLabel: 'secondaryLabel' },
      sectionCaption: sectionCaptionByVariant[ctrl.variant],
    }),
  };
});

import { FeedSectionLabel } from '../FeedSectionLabel';

describe('FeedSectionLabel caption casing', () => {
  it('keeps sentence case in secondaryLabel on Liquid Glass, even on Android', () => {
    ctrl.variant = 'liquidGlass';
    const { getByText, queryByText } = render(createElement(FeedSectionLabel, { label: 'Today' }));
    expect(queryByText('TODAY')).toBeNull();
    expect(getByText('Today').getAttribute('data-color')).toBe('secondaryLabel');
  });

  it('keeps sentence case on Material (was wrongly uppercased on iOS)', () => {
    ctrl.variant = 'material';
    const { getByText } = render(createElement(FeedSectionLabel, { label: 'Today' }));
    expect(getByText('Today')).toBeTruthy();
  });
});
