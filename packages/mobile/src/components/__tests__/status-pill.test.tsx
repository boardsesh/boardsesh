// @vitest-environment jsdom
// StatusPill: the theme's status role (never violet), caption 1 emphasized, and a
// pill that never shrinks or truncates.
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
    emphasized,
    color,
    numberOfLines,
  }: {
    children?: ReactNode;
    variant?: string;
    emphasized?: boolean;
    color?: string;
    numberOfLines?: number;
  }) =>
    createElement(
      'span',
      {
        'data-variant': variant,
        'data-emphasized': String(emphasized ?? false),
        'data-color': color,
        'data-lines': numberOfLines === undefined ? 'unbounded' : String(numberOfLines),
      },
      children,
    ),
}));
vi.mock('../Icon', () => ({
  Icon: ({ name, color }: { name: string; color?: string }) =>
    createElement('i', { 'data-icon': name, 'data-color': color }),
}));
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({
    status: { fill: '#STATUS_FILL', label: '#STATUS_LABEL' },
    brandColors: { success: '#00FF00', warning: '#FFA500' },
  }),
}));

import { StatusPill } from '../StatusPill';

afterEach(cleanup);

describe('StatusPill', () => {
  it('fills with the status role and sets its label in caption 1, emphasized', () => {
    render(<StatusPill label="Closest" testID="pill" />);
    const pill = JSON.parse(screen.getByTestId('pill').getAttribute('data-style') ?? '{}') as Record<string, unknown>;
    expect(pill.backgroundColor).toBe('#STATUS_FILL');
    const label = screen.getByText('Closest');
    expect(label.getAttribute('data-color')).toBe('#STATUS_LABEL');
    expect(label.getAttribute('data-variant')).toBe('caption1');
    expect(label.getAttribute('data-emphasized')).toBe('true');
  });

  it('never shrinks and never truncates', () => {
    render(<StatusPill label="Ready to review" testID="pill" />);
    const pill = JSON.parse(screen.getByTestId('pill').getAttribute('data-style') ?? '{}') as Record<string, unknown>;
    expect(pill.flexShrink).toBe(0);
    expect(screen.getByText('Ready to review').getAttribute('data-lines')).toBe('unbounded');
  });

  it('tints positive and warning with the semantic colour, never the brand violet', () => {
    render(<StatusPill label="Connected" tone="positive" testID="good" />);
    render(<StatusPill label="Improved" tone="warning" testID="warn" />);
    const good = JSON.parse(screen.getByTestId('good').getAttribute('data-style') ?? '{}') as Record<string, unknown>;
    expect(good.backgroundColor).toBe('rgba(0, 255, 0, 0.15)');
    expect(screen.getByText('Connected').getAttribute('data-color')).toBe('#00FF00');
    expect(screen.getByText('Improved').getAttribute('data-color')).toBe('#FFA500');
  });

  it('draws an optional glyph in the label colour', () => {
    const { container } = render(<StatusPill label="Hidden" icon="visibility.off" />);
    const glyph = container.querySelector('[data-icon]');
    expect(glyph?.getAttribute('data-icon')).toBe('visibility.off');
    expect(glyph?.getAttribute('data-color')).toBe('#STATUS_LABEL');
  });
});
