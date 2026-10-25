// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, absoluteFill: {}, hairlineWidth: 1 },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => (options?.count === undefined ? key : `${key}(${options.count})`),
  }),
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
        'data-disabled': String(!!accessibilityState?.disabled),
      },
      leading,
      createElement('span', { 'data-title': 'true' }, title),
      createElement('span', { 'data-subtitle': 'true' }, subtitle),
      trailing,
    ),
}));

import { PlaylistAddToQueueRow } from '../PlaylistAddToQueueRow';

function rows(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('[data-list-row]'));
}

describe('PlaylistAddToQueueRow', () => {
  it('offers Play next above Play last, each with its menu glyph and where it lands', () => {
    const { container } = render(<PlaylistAddToQueueRow onQueue={vi.fn()} pendingPlacement={null} />);

    const [playNextRow, playLastRow] = rows(container);
    expect(rows(container)).toHaveLength(2);
    expect(playNextRow.querySelector('[data-title]')?.textContent).toBe('detail.addToQueue.playNextAction');
    expect(playNextRow.querySelector('[data-subtitle]')?.textContent).toBe('detail.addToQueue.playNextSubtitle');
    expect(playLastRow.querySelector('[data-title]')?.textContent).toBe('detail.addToQueue.action');
    expect(playLastRow.querySelector('[data-subtitle]')?.textContent).toBe('detail.addToQueue.subtitle');
    // The climb menu's own Play next / Play last glyphs and tokens.
    expect(playNextRow.querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('queue.next');
    expect(playNextRow.querySelector('[data-icon]')?.getAttribute('data-icon-color')).toBe('#A78BFA');
    expect(playLastRow.querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('queue.last');
    expect(playLastRow.querySelector('[data-icon]')?.getAttribute('data-icon-color')).toBe('#34D399');
  });

  it('acts rather than navigates, with one divider between the two rows', () => {
    const { container } = render(<PlaylistAddToQueueRow onQueue={vi.fn()} pendingPlacement={null} />);
    const [playNextRow, playLastRow] = rows(container);
    expect(playNextRow.getAttribute('data-chevron')).toBe('false');
    expect(playLastRow.getAttribute('data-chevron')).toBe('false');
    expect(playNextRow.getAttribute('data-separator')).toBe('true');
    expect(playLastRow.getAttribute('data-separator')).toBe('false');
  });

  it('passes the placement each row stands for, and reads its subtitle as the hint', () => {
    const onQueue = vi.fn();
    const { container } = render(<PlaylistAddToQueueRow onQueue={onQueue} pendingPlacement={null} />);
    const [playNextRow, playLastRow] = rows(container);

    expect(playNextRow.getAttribute('aria-label')).toBe('detail.addToQueue.playNextAction');
    expect(playNextRow.getAttribute('data-hint')).toBe('detail.addToQueue.playNextSubtitle');
    expect(playLastRow.getAttribute('aria-label')).toBe('detail.addToQueue.action');
    expect(playLastRow.getAttribute('data-hint')).toBe('detail.addToQueue.subtitle');

    fireEvent.click(playNextRow);
    fireEvent.click(playLastRow);
    expect(onQueue.mock.calls).toEqual([['next'], ['end']]);
  });

  it('shows no spinner and no busy state when idle', () => {
    const { container } = render(<PlaylistAddToQueueRow onQueue={vi.fn()} pendingPlacement={null} />);
    expect(container.querySelector('[data-spinner]')).toBeNull();
    for (const row of rows(container)) {
      expect(row.getAttribute('data-busy')).toBe('false');
      expect(row.getAttribute('data-disabled')).toBe('false');
    }
  });

  it('spins the row in flight, and swallows taps and haptics on both rows meanwhile', () => {
    const onQueue = vi.fn();
    const { container } = render(<PlaylistAddToQueueRow onQueue={onQueue} pendingPlacement="next" />);
    const [playNextRow, playLastRow] = rows(container);

    expect(playNextRow.querySelector('[data-spinner]')).not.toBeNull();
    expect(playLastRow.querySelector('[data-spinner]')).toBeNull();
    expect(playNextRow.getAttribute('data-busy')).toBe('true');
    expect(playLastRow.getAttribute('data-busy')).toBe('false');
    expect(playLastRow.getAttribute('data-disabled')).toBe('true');
    // No haptic on a tap that does nothing.
    expect(playNextRow.getAttribute('data-haptic')).toBe('false');
    expect(playLastRow.getAttribute('data-haptic')).toBe('false');
    fireEvent.click(playNextRow);
    fireEvent.click(playLastRow);
    expect(onQueue).not.toHaveBeenCalled();
  });

  it('says how many a filtered playlist adds, and reads it out the same', () => {
    const { container } = render(<PlaylistAddToQueueRow onQueue={vi.fn()} pendingPlacement={null} count={12} />);
    const [playNextRow, playLastRow] = rows(container);
    expect(playNextRow.querySelector('[data-title]')?.textContent).toBe('detail.addToQueue.playNextActionCount(12)');
    expect(playNextRow.getAttribute('aria-label')).toBe('detail.addToQueue.playNextActionCount(12)');
    expect(playLastRow.querySelector('[data-title]')?.textContent).toBe('detail.addToQueue.actionCount(12)');
    expect(playLastRow.getAttribute('aria-label')).toBe('detail.addToQueue.actionCount(12)');
  });
});
