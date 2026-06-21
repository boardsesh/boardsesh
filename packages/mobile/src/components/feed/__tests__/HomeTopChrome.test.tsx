// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { AppMenuAction } from '../../AppMenu';

const ctrl = vi.hoisted(() => ({ variant: 'liquidGlass' as 'liquidGlass' | 'material' }));

type ViewMockProps = {
  children?: ReactNode;
  onLayout?: (event: { nativeEvent: { layout: { height: number } } }) => void;
};
vi.mock('react-native', () => ({
  View: ({ children, onLayout }: ViewMockProps) =>
    createElement(
      'div',
      {
        'data-has-layout': onLayout ? 'true' : 'false',
        onClick: onLayout ? () => onLayout({ nativeEvent: { layout: { height: 80 } } }) : undefined,
      },
      children,
    ),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, absoluteFill: {}, hairlineWidth: 1 },
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('react-native-paper', () => ({
  Appbar: {
    Header: ({ children }: { children?: ReactNode }) =>
      createElement('div', { 'data-appbar-header': 'true' }, children),
    Action: ({ onPress, accessibilityLabel }: { onPress?: () => void; accessibilityLabel?: string }) =>
      createElement('button', { onClick: onPress, 'data-appbar-action': accessibilityLabel ?? '' }),
  },
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    variant: ctrl.variant,
    systemColors: { label: '#000', secondaryLabel: '#999', separator: '#ccc', secondaryBackground: '#fff' },
  }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 4: 16 } }));

vi.mock('../../ProgressiveBlur', () => ({ ProgressiveBlur: () => createElement('div', { 'data-blur': 'true' }) }));
vi.mock('../../chrome', () => ({
  TOP_ACTION_SIZE: 48,
  GlassActionToolbar: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-island': 'true' }, children),
  GlassToolbarAction: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) => createElement('button', { onClick: onPress, 'data-pressable': accessibilityLabel ?? '' }, children),
}));
vi.mock('../../user-drawer/UserAvatarToolbarAction', () => ({
  UserAvatarToolbarAction: ({ variant }: { variant: 'glass' | 'material' }) =>
    createElement('button', { 'data-avatar-variant': variant }),
}));
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }) }));
vi.mock('../FeedScopeTitle', () => ({
  FeedScopeTitle: ({ title }: { title: string }) => createElement('div', { 'data-feed-scope': 'true' }, title),
}));

import { HomeTopChrome, type HomeTopChromeProps } from '../HomeTopChrome';

const ACTIONS: AppMenuAction[] = [{ label: 'My crew', selected: true }];

function makeProps(over: Partial<HomeTopChromeProps> = {}) {
  return {
    scopeTitle: 'My crew',
    scopeActions: ACTIONS,
    onSelectScopeIndex: vi.fn(),
    onOpenSearch: vi.fn(),
    searchAccessibilityLabel: 'searchLabel',
    scopeAccessibilityHint: 'hint',
    onHeightChange: vi.fn(),
    ...over,
  };
}

const searchAction = (root: HTMLElement) =>
  (root.querySelector('[data-pressable="searchLabel"]') ??
    root.querySelector('[data-appbar-action="searchLabel"]')) as HTMLButtonElement | null;

describe('HomeTopChrome', () => {
  beforeEach(() => {
    ctrl.variant = 'liquidGlass';
  });

  describe('Liquid Glass variant', () => {
    it('renders the floating glass chrome (blur + avatar/search islands + scope title)', () => {
      const { container } = render(<HomeTopChrome {...makeProps()} />);
      expect(container.querySelector('[data-blur]')).not.toBeNull();
      expect(container.querySelector('[data-avatar-variant="glass"]')).not.toBeNull();
      expect(container.querySelector('[data-feed-scope]')?.textContent).toBe('My crew');
      expect(searchAction(container)).not.toBeNull();
      // No M3 app bar on glass.
      expect(container.querySelector('[data-appbar-header]')).toBeNull();
    });

    it('fires onOpenSearch when the find-climbers action is pressed', () => {
      const onOpenSearch = vi.fn();
      const { container } = render(<HomeTopChrome {...makeProps({ onOpenSearch })} />);
      fireEvent.click(searchAction(container)!);
      expect(onOpenSearch).toHaveBeenCalledTimes(1);
    });

    it('reports its measured height through onHeightChange', () => {
      const onHeightChange = vi.fn();
      const { container } = render(<HomeTopChrome {...makeProps({ onHeightChange })} />);
      fireEvent.click(container.querySelector('[data-has-layout="true"]') as HTMLElement);
      expect(onHeightChange).toHaveBeenCalledWith(80);
    });
  });

  describe('Material variant', () => {
    beforeEach(() => {
      ctrl.variant = 'material';
    });

    it('renders an M3 app bar (avatar + scope title-menu + find-climbers action), no glass chrome', () => {
      const { container } = render(<HomeTopChrome {...makeProps()} />);
      expect(container.querySelector('[data-appbar-header]')).not.toBeNull();
      expect(container.querySelector('[data-avatar-variant="material"]')).not.toBeNull();
      expect(container.querySelector('[data-feed-scope]')?.textContent).toBe('My crew');
      expect(searchAction(container)).not.toBeNull();
      // No floating blur / glass islands on Material.
      expect(container.querySelector('[data-blur]')).toBeNull();
      expect(container.querySelector('[data-island]')).toBeNull();
    });

    it('fires onOpenSearch from the app-bar action', () => {
      const onOpenSearch = vi.fn();
      const { container } = render(<HomeTopChrome {...makeProps({ onOpenSearch })} />);
      fireEvent.click(searchAction(container)!);
      expect(onOpenSearch).toHaveBeenCalledTimes(1);
    });

    it('reports the app bar height through onHeightChange', () => {
      const onHeightChange = vi.fn();
      const { container } = render(<HomeTopChrome {...makeProps({ onHeightChange })} />);
      fireEvent.click(container.querySelector('[data-has-layout="true"]') as HTMLElement);
      expect(onHeightChange).toHaveBeenCalledWith(80);
    });
  });
});
