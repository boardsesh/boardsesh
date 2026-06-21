// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const haptics = vi.hoisted(() => ({ selection: vi.fn() }));

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  View: ({
    children,
    accessibilityRole,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    accessibilityRole?: string;
    accessibilityLabel?: string;
  }) => createElement('div', { role: accessibilityRole, 'aria-label': accessibilityLabel }, children),
}));

vi.mock('react-native-reanimated', () => ({
  default: { View: ({ children }: { children?: ReactNode }) => createElement('div', null, children) },
  useAnimatedStyle: () => ({}),
  useDerivedValue: (fn: () => unknown) => ({ value: fn() }),
  withTiming: (value: number) => value,
}));

vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));

// PressableSurface forwards onPress to a button and mirrors the tab role /
// selected state so the test can read them off the DOM (matching MaterialTabBar's
// test double).
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    accessibilityRole,
    accessibilityState,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityRole?: string;
    accessibilityState?: { selected?: boolean };
    accessibilityLabel?: string;
  }) =>
    createElement(
      'button',
      {
        onClick: onPress,
        role: accessibilityRole,
        'aria-selected': accessibilityState?.selected,
        'aria-label': accessibilityLabel,
      },
      children,
    ),
}));

vi.mock('../../../lib/haptics', () => ({ hapticSelection: haptics.selection }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 3: 12 } }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    m3: { primary: '#6750A4', onSurfaceVariant: '#49454F' },
    brandColors: { primary: '#6D28D9' },
  }),
}));

import { MaterialTabs } from '../MaterialTabs';

const OPTIONS = [
  { key: 'progress', label: 'Progress' },
  { key: 'sessions', label: 'Sessions' },
  { key: 'logbook', label: 'Logbook' },
];

function makeProps(over: Partial<Parameters<typeof MaterialTabs>[0]> = {}) {
  return {
    options: OPTIONS,
    selectedKey: 'progress',
    onSelect: vi.fn(),
    accessibilityLabel: 'Dashboard',
    ...over,
  };
}

describe('MaterialTabs', () => {
  it('renders all option labels', () => {
    const { getByText } = render(<MaterialTabs {...makeProps()} />);
    expect(getByText('Progress')).not.toBeNull();
    expect(getByText('Sessions')).not.toBeNull();
    expect(getByText('Logbook')).not.toBeNull();
  });

  it('marks the selected tab as selected and the rest as not selected', () => {
    const { getAllByRole } = render(<MaterialTabs {...makeProps({ selectedKey: 'sessions' })} />);
    const tabs = getAllByRole('tab');
    expect(tabs[0].getAttribute('aria-selected')).toBe('false');
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    expect(tabs[2].getAttribute('aria-selected')).toBe('false');
  });

  it('uses each option label as its tab accessibility label', () => {
    const { getAllByRole } = render(<MaterialTabs {...makeProps()} />);
    const tabs = getAllByRole('tab');
    expect(tabs.map((tab) => tab.getAttribute('aria-label'))).toEqual(['Progress', 'Sessions', 'Logbook']);
  });

  it('fires onSelect with the pressed tab key', () => {
    const onSelect = vi.fn();
    const { getAllByRole } = render(<MaterialTabs {...makeProps({ onSelect })} />);
    const tabs = getAllByRole('tab');
    fireEvent.click(tabs[2]);
    expect(onSelect).toHaveBeenCalledWith('logbook');
  });

  it('exposes the group accessibility label on a tablist', () => {
    const { getByRole } = render(<MaterialTabs {...makeProps({ accessibilityLabel: 'Dashboard' })} />);
    expect(getByRole('tablist').getAttribute('aria-label')).toBe('Dashboard');
  });
});
