// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, absoluteFill: {}, hairlineWidth: 1 },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { label: '#000', fill: '#eee' } }),
}));
vi.mock('../../../hooks/use-native-glass', () => ({ useNativeGlass: () => false }));
vi.mock('../../../theme/tokens', () => ({ shadows: { sm: {} } }));
vi.mock('../../../theme/layout', () => ({ glassSize: { standard: 48 } }));
vi.mock('../../GlassSurface', () => ({ GlassSurface: () => createElement('div', { 'data-glass': 'true' }) }));
vi.mock('../../ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('div', { 'data-spinner': 'true' }),
}));
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }) }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));

type PressProps = { children?: ReactNode; onPress?: () => void; accessibilityLabel?: string };
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({ children, onPress, accessibilityLabel }: PressProps) =>
    createElement('button', { 'data-pill': 'true', onClick: onPress, 'aria-label': accessibilityLabel }, children),
}));
type FabProps = { iconName: string; onPress?: () => void; accessibilityLabel?: string };
vi.mock('../../GlassIconButton', () => ({
  GlassIconButton: ({ iconName, onPress, accessibilityLabel }: FabProps) =>
    createElement('button', {
      'data-fab': 'true',
      'data-icon': iconName,
      onClick: onPress,
      'aria-label': accessibilityLabel,
    }),
}));

import { PlaylistFollowButton } from '../PlaylistFollowButton';

const pill = (root: HTMLElement) => root.querySelector('[data-pill]') as HTMLButtonElement | null;
const fab = (root: HTMLElement) => root.querySelector('[data-fab]') as HTMLButtonElement | null;

describe('PlaylistFollowButton', () => {
  it('renders a glass pill with the follow label when expanded', () => {
    const { container } = render(<PlaylistFollowButton isFollowing={false} onToggle={vi.fn()} />);
    expect(pill(container)).not.toBeNull();
    expect(fab(container)).toBeNull();
    expect(container.querySelector('[data-icon="person.badge.plus"]')).not.toBeNull();
    expect(container.textContent).toContain('follow.follow');
  });

  it('shows the following state (checkmark + label)', () => {
    const { container } = render(<PlaylistFollowButton isFollowing onToggle={vi.fn()} />);
    expect(container.querySelector('[data-icon="check.small"]')).not.toBeNull();
    expect(container.textContent).toContain('follow.following');
  });

  it('collapses to an icon FAB in header mode', () => {
    const { container } = render(<PlaylistFollowButton isFollowing={false} onToggle={vi.fn()} collapsed />);
    expect(fab(container)?.getAttribute('data-icon')).toBe('person.badge.plus');
    expect(pill(container)).toBeNull();
  });

  it('calls onToggle from both the pill and the collapsed FAB', () => {
    const onToggle = vi.fn();
    const { container, rerender } = render(<PlaylistFollowButton isFollowing={false} onToggle={onToggle} />);
    fireEvent.click(pill(container)!);
    rerender(<PlaylistFollowButton isFollowing={false} onToggle={onToggle} collapsed />);
    fireEvent.click(fab(container)!);
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it('shows a spinner instead of the icon while loading', () => {
    const { container } = render(<PlaylistFollowButton isFollowing={false} onToggle={vi.fn()} loading />);
    expect(container.querySelector('[data-spinner]')).not.toBeNull();
    expect(container.querySelector('[data-icon]')).toBeNull();
  });
});
