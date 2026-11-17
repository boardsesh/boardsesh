// @vitest-environment jsdom
// EmptyState at its three weights: a centred placard for a screen or a section,
// and a single quiet line at the gutter with a trailing action.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

vi.mock('react-native', async () => {
  const { flattenStyle } = await import('../../../test/flatten-style');
  return {
    Platform: { OS: 'ios' },
    PlatformColor: (name: string) => name,
    DynamicColorIOS: (appearances: { light: string }) => appearances.light,
    StyleSheet: { create: <T,>(styles: T): T => styles },
    View: ({ children, style, testID }: { children?: ReactNode; style?: unknown; testID?: string }) =>
      createElement('div', { 'data-testid': testID, 'data-style': JSON.stringify(flattenStyle(style)) }, children),
  };
});
vi.mock('../Text', () => ({
  Text: ({
    children,
    variant,
    tone,
    style,
  }: {
    children?: ReactNode;
    variant?: string;
    tone?: string;
    style?: { textAlign?: string };
  }) =>
    createElement(
      'span',
      { 'data-variant': variant, 'data-tone': tone ?? 'primary', 'data-align': style?.textAlign ?? 'auto' },
      children,
    ),
}));
vi.mock('../Icon', () => ({
  Icon: ({ name, size, color }: { name: string; size?: number; color?: string }) =>
    createElement('i', { 'data-icon': name, 'data-size': size, 'data-color': color }),
}));
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { tertiaryLabel: '#TERTIARY' } }),
}));

import { EmptyState } from '../EmptyState';

function styleOf(element: Element | null): Record<string, unknown> {
  return JSON.parse(element?.getAttribute('data-style') ?? '{}') as Record<string, unknown>;
}

afterEach(cleanup);

describe('EmptyState', () => {
  it('centres a screen placard: icon, headline title, secondary body, actions', () => {
    render(
      <EmptyState
        size="screen"
        icon="boards"
        title="No boards yet"
        body="Add the board you climb on."
        actions={<button type="button">Add a board</button>}
        testID="empty"
      />,
    );
    const root = styleOf(screen.getByTestId('empty'));
    expect(root.flex).toBe(1);
    expect(root.alignItems).toBe('center');
    expect(root.justifyContent).toBe('center');
    const icon = screen.getByTestId('empty').querySelector('[data-icon="boards"]');
    expect(icon?.getAttribute('data-color')).toBe('#TERTIARY');
    expect(icon?.getAttribute('data-size')).toBe('40');
    const title = screen.getByText('No boards yet');
    expect(title.getAttribute('data-variant')).toBe('headline');
    expect(title.getAttribute('data-tone')).toBe('primary');
    expect(title.getAttribute('data-align')).toBe('center');
    const body = screen.getByText('Add the board you climb on.');
    expect(body.getAttribute('data-variant')).toBe('subheadline');
    expect(body.getAttribute('data-tone')).toBe('secondary');
    expect(screen.getByRole('button', { name: 'Add a board' })).toBeTruthy();
  });

  it('pads a section placard instead of filling the screen', () => {
    render(<EmptyState size="section" title="No sends this week" testID="empty" />);
    const root = styleOf(screen.getByTestId('empty'));
    expect(root.flex).toBeUndefined();
    expect(root.paddingVertical).toBe(32);
    expect(root.alignItems).toBe('center');
  });

  it('is one secondary footnote line at the gutter when quiet, with the action trailing', () => {
    render(
      <EmptyState
        size="quiet"
        title="Nothing near you"
        actions={<button type="button">Retry</button>}
        testID="empty"
      />,
    );
    const root = styleOf(screen.getByTestId('empty'));
    expect(root.flexDirection).toBe('row');
    expect(root.paddingHorizontal).toBe(16);
    expect(root.minHeight).toBeUndefined();
    expect(root.paddingVertical).toBeUndefined();
    const line = screen.getByText('Nothing near you');
    expect(line.getAttribute('data-variant')).toBe('footnote');
    expect(line.getAttribute('data-tone')).toBe('secondary');
    expect(line.getAttribute('data-align')).toBe('auto');
    expect(screen.getByTestId('empty').lastElementChild?.textContent).toBe('Retry');
  });
});
