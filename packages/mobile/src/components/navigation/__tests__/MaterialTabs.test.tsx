// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { act, render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const haptics = vi.hoisted(() => ({ selection: vi.fn() }));

type LayoutHandler = (event: { nativeEvent: { layout: { width: number } } }) => void;
// The latest onLayout handed to the tablist container and to each label, keyed
// by label text, so a test can feed in the measurements the native side would.
const layoutHandlers = vi.hoisted(() => ({
  container: undefined as LayoutHandler | undefined,
  labels: new Map<string, LayoutHandler>(),
}));

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  View: ({
    children,
    accessibilityRole,
    accessibilityLabel,
    onLayout,
  }: {
    children?: ReactNode;
    accessibilityRole?: string;
    accessibilityLabel?: string;
    onLayout?: LayoutHandler;
  }) => {
    if (accessibilityRole === 'tablist') layoutHandlers.container = onLayout;
    return createElement('div', { role: accessibilityRole, 'aria-label': accessibilityLabel }, children);
  },
}));

vi.mock('react-native-reanimated', () => ({
  default: {
    View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
      createElement('div', { 'data-testid': testID }, children),
  },
  useAnimatedStyle: () => ({}),
  useDerivedValue: (fn: () => unknown) => ({ value: fn() }),
  withTiming: (value: number) => value,
}));

vi.mock('../../Text', () => ({
  Text: ({ children, onLayout }: { children?: ReactNode; onLayout?: LayoutHandler }) => {
    if (typeof children === 'string' && onLayout) layoutHandlers.labels.set(children, onLayout);
    return createElement('span', null, children);
  },
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

import { MaterialTabs, primaryIndicatorGeometry } from '../MaterialTabs';

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

function layout(handler: LayoutHandler | undefined, width: number) {
  act(() => handler?.({ nativeEvent: { layout: { width } } }));
}

describe('MaterialTabs indicator', () => {
  it('appears only once the container and the active label are measured', () => {
    const { queryByTestId } = render(<MaterialTabs {...makeProps({ selectedKey: 'sessions' })} />);
    expect(queryByTestId('material-tabs-indicator')).toBeNull();

    layout(layoutHandlers.container, 360);
    layout(layoutHandlers.labels.get('Progress'), 60);
    expect(queryByTestId('material-tabs-indicator')).toBeNull();

    layout(layoutHandlers.labels.get('Sessions'), 64);
    expect(queryByTestId('material-tabs-indicator')).not.toBeNull();
  });

  it('falls back to the first tab when selectedKey is not an option', () => {
    const { queryByTestId } = render(<MaterialTabs {...makeProps({ selectedKey: 'missing' })} />);
    layout(layoutHandlers.container, 360);
    layout(layoutHandlers.labels.get('Progress'), 60);
    expect(queryByTestId('material-tabs-indicator')).not.toBeNull();
  });
});

describe('primaryIndicatorGeometry', () => {
  it('stays hidden until the slot and the active label are measured', () => {
    expect(primaryIndicatorGeometry(0, 0, 60)).toBeNull();
    expect(primaryIndicatorGeometry(120, 0, undefined)).toBeNull();
    expect(primaryIndicatorGeometry(120, 0, 0)).toBeNull();
  });

  it('matches the label width and centres it in the active slot', () => {
    expect(primaryIndicatorGeometry(120, 0, 60)).toEqual({ width: 60, offset: 30 });
    expect(primaryIndicatorGeometry(120, 2, 70)).toEqual({ width: 70, offset: 265 });
  });

  it('never draws narrower than 24dp', () => {
    expect(primaryIndicatorGeometry(120, 1, 10)).toEqual({ width: 24, offset: 168 });
  });

  it('never spills past its own slot', () => {
    expect(primaryIndicatorGeometry(80, 1, 140)).toEqual({ width: 80, offset: 80 });
  });
});
