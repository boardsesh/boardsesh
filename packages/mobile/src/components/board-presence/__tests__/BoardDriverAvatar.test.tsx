// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));

// PressableAvatar → expose identity + a11y so the atom's prop-passing is
// assertable without the expo-router / Pressable tree.
type AvatarProps = { userId?: string | null; name?: string | null; size?: number; accessibilityLabel?: string };
vi.mock('../../PressableAvatar', () => ({
  PressableAvatar: ({ userId, name, size, accessibilityLabel }: AvatarProps) =>
    createElement('div', {
      'data-avatar': 'true',
      'data-user-id': userId ?? '',
      'data-name': name ?? '',
      'data-size': size == null ? '' : String(size),
      'data-a11y': accessibilityLabel,
    }),
}));
vi.mock('../../Icon', () => ({
  Icon: ({ name, color }: { name?: string; color?: string }) =>
    createElement('i', { 'data-icon': name, 'data-color': color }),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', { 'data-text': 'true' }, children),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    brandColors: { warning: '#B45309' },
    systemColors: { secondaryBackground: '#FFFFFF', background: '#F4F1FB', secondaryLabel: '#8E8E93' },
  }),
}));
vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: { systemGray: '#8E8E93' } }));

import { BoardDriverAvatar } from '../BoardDriverAvatar';

const bluetoothBadge = (container: HTMLElement) => container.querySelector('[data-icon="bluetooth.connected"]');
const idleGlyph = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('[data-text="true"]')).find((node) => node.textContent === '?');

describe('BoardDriverAvatar', () => {
  it('shows an amber Bluetooth badge for the connected driver and passes the profile link through', () => {
    const { container } = render(
      createElement(BoardDriverAvatar, {
        userId: 'u1',
        name: 'Marco',
        status: 'connected',
        accessibilityLabel: 'a11y',
      }),
    );
    const badge = bluetoothBadge(container);

    expect(badge).toBeTruthy();
    expect(badge?.getAttribute('data-color')).toBe('#B45309');
    expect(idleGlyph(container)).toBeFalsy();

    const avatar = container.querySelector('[data-avatar="true"]');
    expect(avatar?.getAttribute('data-user-id')).toBe('u1');
    expect(avatar?.getAttribute('data-a11y')).toBe('a11y');
  });

  it('swaps the badge for a "?" when the holder has gone idle — never both', () => {
    const { container } = render(createElement(BoardDriverAvatar, { name: 'Marco', status: 'idle' }));

    expect(idleGlyph(container)).toBeTruthy();
    expect(bluetoothBadge(container)).toBeFalsy();
  });

  it('renders no corner badge for a past send (status="none")', () => {
    const { container } = render(createElement(BoardDriverAvatar, { userId: 'u1', name: 'Marco', status: 'none' }));

    expect(bluetoothBadge(container)).toBeFalsy();
    expect(idleGlyph(container)).toBeFalsy();
    // The avatar itself still renders.
    expect(container.querySelector('[data-avatar="true"]')).toBeTruthy();
  });

  it('shows a corner text label (e.g. elapsed time) in place of the glyph when provided', () => {
    const { container } = render(
      createElement(BoardDriverAvatar, { userId: 'u1', name: 'Marco', status: 'connected', cornerLabel: '3h' }),
    );

    // The label takes the badge slot — the Bluetooth glyph and "?" are gone.
    expect(container.textContent).toContain('3h');
    expect(bluetoothBadge(container)).toBeFalsy();
    expect(idleGlyph(container)).toBeFalsy();
  });

  it('stays non-interactive for an anonymous holder (no userId) while keeping the badge', () => {
    const { container } = render(createElement(BoardDriverAvatar, { name: null, status: 'connected' }));

    expect(container.querySelector('[data-avatar="true"]')?.getAttribute('data-user-id')).toBe('');
    expect(bluetoothBadge(container)).toBeTruthy();
  });
});
