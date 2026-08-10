// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
  Platform: { OS: 'ios' },
  PlatformColor: (name: string) => name,
}));
vi.mock('../Text', () => ({ Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children) }));
vi.mock('../Icon', () => ({ Icon: () => createElement('i', null) }));
// Keep the two press targets distinguishable, and carry through the a11y props
// the disclosure sets so they can be asserted.
vi.mock('../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    accessibilityLabel,
    accessibilityState,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
    accessibilityState?: { expanded?: boolean };
  }) =>
    createElement(
      'button',
      {
        onClick: () => onPress?.(),
        'aria-label': accessibilityLabel,
        'data-expanded': accessibilityState?.expanded === undefined ? undefined : String(accessibilityState.expanded),
      },
      children,
    ),
}));
vi.mock('../SectionDisclosureChevron', () => ({
  SectionDisclosureChevron: ({ expanded }: { expanded: boolean }) =>
    createElement('i', { 'data-testid': 'chevron', 'data-expanded': String(expanded) }),
}));
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({
    variant: 'material' as const,
    brandColors: { primary: '#6D28D9' },
    m3: { onSurfaceVariant: '#49454F' },
    sectionCaption: { uppercase: false, opacity: 1, letterSpacing: 0 },
  }),
}));

import { SectionHeader } from '../SectionHeader';

describe('SectionHeader disclosure', () => {
  it('stays a plain header when no disclosure props are passed', () => {
    const { queryByTestId, queryByRole } = render(createElement(SectionHeader, { title: 'Fresh beta' }));
    expect(queryByTestId('chevron')).toBeNull();
    expect(queryByRole('button')).toBeNull();
  });

  it('renders a chevron and exposes the expanded state to screen readers', () => {
    const { getByTestId, getByLabelText } = render(
      createElement(SectionHeader, { title: 'Fresh beta', disclosure: { expanded: false, onToggle: vi.fn() } }),
    );

    expect(getByTestId('chevron').getAttribute('data-expanded')).toBe('false');
    // Labelled with the raw title, not the transformed caption.
    expect(getByLabelText('Fresh beta').getAttribute('data-expanded')).toBe('false');
  });

  it('toggles when the title is tapped', () => {
    const onToggle = vi.fn();
    const { getByLabelText } = render(
      createElement(SectionHeader, { title: 'Fresh beta', disclosure: { expanded: true, onToggle } }),
    );

    fireEvent.click(getByLabelText('Fresh beta'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('keeps "See all" independent of the disclosure', () => {
    // The action is a sibling of the disclosure, not nested inside it — pressing
    // it must navigate without also folding the shelf away.
    const onToggle = vi.fn();
    const onActionPress = vi.fn();
    const { getByLabelText } = render(
      createElement(SectionHeader, {
        title: 'Fresh beta',
        disclosure: { expanded: true, onToggle },
        actionLabel: 'See all',
        onActionPress,
      }),
    );

    fireEvent.click(getByLabelText('See all'));
    expect(onActionPress).toHaveBeenCalledTimes(1);
    expect(onToggle).not.toHaveBeenCalled();
  });
});
