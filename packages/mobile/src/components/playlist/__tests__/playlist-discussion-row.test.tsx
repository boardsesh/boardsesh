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
    t: (key: string, options?: { count?: number }) =>
      options && typeof options.count === 'number' ? `${key}:${options.count}` : key,
  }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { label: '#000', secondaryLabel: '#666' } }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12 } }));
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }) }));

type ListRowProps = {
  title: string;
  subtitle?: string;
  leading?: ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
};
vi.mock('../../ListRow', () => ({
  ListRow: ({ title, subtitle, leading, onPress, accessibilityLabel }: ListRowProps) =>
    createElement(
      'button',
      { 'data-list-row': 'true', onClick: onPress, 'aria-label': accessibilityLabel },
      leading,
      createElement('span', { 'data-title': 'true' }, title),
      createElement('span', { 'data-subtitle': 'true' }, subtitle),
    ),
}));

import { PlaylistDiscussionRow } from '../PlaylistDiscussionRow';

const subtitleOf = (root: HTMLElement) => root.querySelector('[data-subtitle]')?.textContent;

describe('PlaylistDiscussionRow', () => {
  it('renders the discussion title and a comment icon', () => {
    const { container } = render(<PlaylistDiscussionRow commentCount={3} onPress={vi.fn()} />);
    expect(container.querySelector('[data-title]')?.textContent).toBe('detail.discussion');
    expect(container.querySelector('[data-icon="comment"]')).not.toBeNull();
  });

  it('passes the comment count through to the pluralised count key', () => {
    expect(subtitleOf(render(<PlaylistDiscussionRow commentCount={0} onPress={vi.fn()} />).container)).toBe(
      'comment.count:0',
    );
    expect(subtitleOf(render(<PlaylistDiscussionRow commentCount={1} onPress={vi.fn()} />).container)).toBe(
      'comment.count:1',
    );
    expect(subtitleOf(render(<PlaylistDiscussionRow commentCount={12} onPress={vi.fn()} />).container)).toBe(
      'comment.count:12',
    );
  });

  it('fires onPress once when tapped', () => {
    const onPress = vi.fn();
    const { container } = render(<PlaylistDiscussionRow commentCount={2} onPress={onPress} />);
    fireEvent.click(container.querySelector('[data-list-row]') as HTMLButtonElement);
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
