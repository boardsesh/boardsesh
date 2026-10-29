// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const haptics = vi.hoisted(() => ({ light: vi.fn() }));

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
  View: ({
    children,
    accessibilityRole,
    accessible,
  }: {
    children?: ReactNode;
    accessibilityRole?: string;
    accessible?: boolean;
  }) =>
    createElement(
      'div',
      { 'data-role': accessibilityRole ?? '', 'data-accessible': String(Boolean(accessible)) },
      children,
    ),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { label: '#000', secondaryLabel: '#888', fill: '#eee' },
    brandColors: { primary: '#6D28D9' },
  }),
}));
vi.mock('../../../lib/haptics', () => ({ hapticLight: haptics.light }));
vi.mock('../../../lib/showcase-anchor', () => ({ useShowcaseAnchor: () => ({ onLayout: undefined }) }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4 } }));
vi.mock('../../Badge', () => ({ Badge: () => createElement('span', { 'data-badge-dot': 'true' }) }));
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }) }));
vi.mock('../../Text', () => ({
  Text: ({ children, variant }: { children?: ReactNode; variant?: string }) =>
    createElement('span', { 'data-variant': variant }, children),
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    accessibilityRole,
    accessibilityLabel,
    accessibilityHint,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityRole?: string;
    accessibilityLabel?: string;
    accessibilityHint?: string;
  }) =>
    createElement(
      'button',
      {
        onClick: onPress,
        'data-role': accessibilityRole,
        'data-label': accessibilityLabel,
        'data-hint': accessibilityHint,
      },
      children,
    ),
}));

import { MaterialAppBarTitle } from '../MaterialAppBarTitle';

describe('MaterialAppBarTitle', () => {
  beforeEach(() => haptics.light.mockClear());

  it('is a header, not a button, when it has nothing to do', () => {
    const { container } = render(<MaterialAppBarTitle title="Test User" />);
    expect(container.querySelector('button')).toBeNull();
    const header = container.querySelector('[data-role="header"]');
    expect(header?.getAttribute('data-accessible')).toBe('true');
    expect(header?.querySelector('[data-variant="title2"]')?.textContent).toBe('Test User');
  });

  it('is one button named by title and subtitle, with a caret under the title', () => {
    const onPress = vi.fn();
    const { container } = render(
      <MaterialAppBarTitle title="Climbs" subtitle="The Slab Lab" onPress={onPress} accessibilityHint="Switch board" />,
    );
    const button = container.querySelector('button')!;
    expect(button.getAttribute('data-role')).toBe('button');
    expect(button.getAttribute('data-label')).toBe('Climbs, The Slab Lab');
    expect(button.getAttribute('data-hint')).toBe('Switch board');
    expect(button.querySelector('[data-variant="subheadline"]')?.textContent).toBe('The Slab Lab');
    expect(button.querySelector('[data-icon="chevron.down"]')).not.toBeNull();
    fireEvent.click(button);
    expect(onPress).toHaveBeenCalledOnce();
    expect(haptics.light).toHaveBeenCalledOnce();
  });

  it('reads a pressable title without a subtitle as the title alone, with no caret', () => {
    const { container } = render(<MaterialAppBarTitle title="Tuesday sesh" onPress={vi.fn()} />);
    expect(container.querySelector('button')?.getAttribute('data-label')).toBe('Tuesday sesh');
    expect(container.querySelector('[data-icon="chevron.down"]')).toBeNull();
  });

  it('shows the onboarding dot only when asked', () => {
    const props = { title: 'Discover', subtitle: 'Kilter • M', onPress: vi.fn() };
    const { container, rerender } = render(<MaterialAppBarTitle {...props} />);
    expect(container.querySelector('[data-badge-dot]')).toBeNull();
    rerender(<MaterialAppBarTitle {...props} badge />);
    expect(container.querySelector('[data-badge-dot]')).not.toBeNull();
  });
});
