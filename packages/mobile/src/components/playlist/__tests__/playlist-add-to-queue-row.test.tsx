// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, absoluteFill: {}, hairlineWidth: 1 },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { label: '#000', secondaryLabel: '#666' },
    actionColors: { success: '#34D399', favorite: '#F87171', accent: '#A78BFA' },
  }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12 } }));
vi.mock('../../Icon', () => ({
  Icon: ({ name, color }: { name: string; color?: string }) =>
    createElement('span', { 'data-icon': name, 'data-icon-color': color }),
}));
vi.mock('../../ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('span', { 'data-spinner': 'true' }),
}));

type ListRowProps = {
  title: string;
  subtitle?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  onPress?: () => void;
  haptic?: boolean;
  showChevron?: boolean;
  showSeparator?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityState?: { busy?: boolean; disabled?: boolean };
};
vi.mock('../../ListRow', () => ({
  ListRow: ({
    title,
    subtitle,
    leading,
    trailing,
    onPress,
    haptic,
    showChevron,
    showSeparator,
    accessibilityLabel,
    accessibilityHint,
    accessibilityState,
  }: ListRowProps) =>
    createElement(
      'button',
      {
        'data-list-row': 'true',
        onClick: onPress,
        'aria-label': accessibilityLabel,
        'data-hint': accessibilityHint,
        'data-haptic': String(!!haptic),
        'data-chevron': String(!!showChevron),
        'data-separator': String(!!showSeparator),
        'data-busy': String(!!accessibilityState?.busy),
      },
      leading,
      createElement('span', { 'data-title': 'true' }, title),
      createElement('span', { 'data-subtitle': 'true' }, subtitle),
      trailing,
    ),
}));

import { PlaylistAddToQueueRow } from '../PlaylistAddToQueueRow';

describe('PlaylistAddToQueueRow', () => {
  it('renders the action title, the reassurance subtitle and the success add glyph', () => {
    const { container } = render(<PlaylistAddToQueueRow onPress={vi.fn()} isAppending={false} />);

    expect(container.querySelector('[data-title]')?.textContent).toBe('detail.addToQueue.action');
    expect(container.querySelector('[data-subtitle]')?.textContent).toBe('detail.addToQueue.subtitle');
    // Same glyph + token as the climb long-press sheet's "Add to queue" row, so
    // the additive action reads identically wherever it appears.
    const icon = container.querySelector('[data-icon="add"]');
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute('data-icon-color')).toBe('#34D399');
  });

  it('acts rather than navigates, and draws no separator of its own', () => {
    const { container } = render(<PlaylistAddToQueueRow onPress={vi.fn()} isAppending={false} />);
    const row = container.querySelector('[data-list-row]');
    expect(row?.getAttribute('data-chevron')).toBe('false');
    expect(row?.getAttribute('data-separator')).toBe('false');
  });

  it('fires onPress and exposes the subtitle as the screen-reader hint', () => {
    const onPress = vi.fn();
    const { container } = render(<PlaylistAddToQueueRow onPress={onPress} isAppending={false} />);

    const row = container.querySelector('[data-list-row]') as HTMLButtonElement;
    expect(row.getAttribute('aria-label')).toBe('detail.addToQueue.action');
    expect(row.getAttribute('data-hint')).toBe('detail.addToQueue.subtitle');
    fireEvent.click(row);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('shows no spinner and no busy state when idle', () => {
    const { container } = render(<PlaylistAddToQueueRow onPress={vi.fn()} isAppending={false} />);
    expect(container.querySelector('[data-spinner]')).toBeNull();
    expect(container.querySelector('[data-list-row]')?.getAttribute('data-busy')).toBe('false');
  });

  it('swallows the press, the haptic and announces busy while appending', () => {
    const onPress = vi.fn();
    const { container } = render(<PlaylistAddToQueueRow onPress={onPress} isAppending />);

    const row = container.querySelector('[data-list-row]') as HTMLButtonElement;
    expect(container.querySelector('[data-spinner]')).not.toBeNull();
    expect(row.getAttribute('data-busy')).toBe('true');
    // No haptic on a tap that does nothing.
    expect(row.getAttribute('data-haptic')).toBe('false');
    fireEvent.click(row);
    expect(onPress).not.toHaveBeenCalled();
  });
});
