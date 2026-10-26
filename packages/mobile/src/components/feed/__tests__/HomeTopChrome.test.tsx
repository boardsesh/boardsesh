// @vitest-environment jsdom
vi.mock('../../../hooks/use-native-root-bar-items', () => ({ useNativeRootBarItems: () => ctrl.nativeBarItems }));
// The live item hooks have their own suite; these stand-ins keep the wiring visible.
vi.mock('../../chrome/use-root-bar-items', () => ({
  useAccountRailItem: () => ({ type: 'button', label: 'account', onPress: () => undefined }),
  useBarItemsOnRail: () => ctrl.onRail,
  useNotificationsBarItem: (onOpen: () => void) => ({ type: 'button', label: 'notifications', onPress: onOpen }),
}));
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { AppMenuAction } from '../../AppMenu';

const ctrl = vi.hoisted(() => ({
  variant: 'liquidGlass' as 'liquidGlass' | 'material',
  nativeHeader: false,
  nativeBarItems: false,
  onRail: false,
  nativeHeaderProps: undefined as
    | {
        title?: string;
        leftActionsStandalone?: boolean;
        leftActions?: ReactNode;
        children?: ReactNode;
        leftItems?: () => BarItemStandIn[];
        rightItems?: () => BarItemStandIn[];
      }
    | undefined,
}));

type BarItemStandIn = { label?: string; onPress?: () => void; icon?: { type: string; name?: string } };

type ViewMockProps = {
  children?: ReactNode;
  onLayout?: (event: { nativeEvent: { layout: { height: number } } }) => void;
};
vi.mock('../../../hooks/use-native-root-header', () => ({ useNativeRootHeader: () => ctrl.nativeHeader }));
vi.mock('../../chrome/NativeRootHeader', () => ({
  NativeRootHeader: (props: typeof ctrl.nativeHeaderProps) => {
    ctrl.nativeHeaderProps = props;
    return createElement('div', { 'data-native-root-header': 'true' }, props?.children);
  },
}));

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
    Content: ({ title }: { title: string }) => createElement('div', { 'data-appbar-content': 'true' }, title),
  },
}));

// The chrome owns the notifications push itself, so the bell takes no new prop
// from the host — this captures where it sends the user.
const routerMock = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('expo-router', () => ({ useRouter: () => routerMock }));

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
  NATIVE_ACTION_SIZE: 38,
  toolbarGlyphSize: (baseSize: number, actionSize: number) => Math.round(baseSize * Math.min(1, actionSize / 44)),
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
vi.mock('../../chrome/NotificationsToolbarAction', () => ({
  NotificationsToolbarAction: ({ variant, onPress }: { variant: 'glass' | 'material'; onPress: () => void }) =>
    createElement('button', { 'data-bell-variant': variant, onClick: onPress }),
}));
vi.mock('../../Text', () => ({
  Text: ({ children, accessibilityRole }: { children?: ReactNode; accessibilityRole?: string }) =>
    createElement(
      'p',
      { 'data-plain-title': 'true', role: accessibilityRole === 'header' ? 'heading' : undefined },
      children,
    ),
}));
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }) }));
vi.mock('../FeedScopeTitle', () => ({
  FeedScopeTitle: ({ title }: { title: string }) => createElement('div', { 'data-feed-scope': 'true' }, title),
}));

import { HomeTopChrome, type HomeTopChromeProps } from '../HomeTopChrome';

const ACTIONS: AppMenuAction[] = [{ label: 'My crew', selected: true }];

function makeProps(over: Partial<HomeTopChromeProps> = {}) {
  return {
    showScopeMenu: true,
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

const bell = (root: HTMLElement, variant: 'glass' | 'material') =>
  root.querySelector(`[data-bell-variant="${variant}"]`) as HTMLButtonElement | null;

describe('HomeTopChrome', () => {
  beforeEach(() => {
    ctrl.variant = 'liquidGlass';
    ctrl.nativeHeader = false;
    ctrl.nativeBarItems = false;
    ctrl.onRail = false;
    ctrl.nativeHeaderProps = undefined;
    routerMock.push.mockClear();
  });

  describe('notifications bell', () => {
    it('renders the glass bell and pushes the Home stack route', () => {
      const { container } = render(<HomeTopChrome {...makeProps()} />);
      const glassBell = bell(container, 'glass');
      expect(glassBell).not.toBeNull();

      fireEvent.click(glassBell!);
      // Home's OWN stack, not the Profile one — Back must land on the feed.
      expect(routerMock.push).toHaveBeenCalledWith('/(tabs)/home/notifications');
    });

    it('renders the material bell and pushes the same route', () => {
      ctrl.variant = 'material';
      const { container } = render(<HomeTopChrome {...makeProps()} />);
      const materialBell = bell(container, 'material');
      expect(materialBell).not.toBeNull();

      fireEvent.click(materialBell!);
      expect(routerMock.push).toHaveBeenCalledWith('/(tabs)/home/notifications');
    });
  });

  describe('Liquid Glass variant', () => {
    it('leaves the scope picker in the feed and uses the native Home title', () => {
      ctrl.nativeHeader = true;
      const { container } = render(<HomeTopChrome {...makeProps()} />);

      expect(container.querySelector('[data-native-root-header]')).not.toBeNull();
      expect(container.querySelector('[data-feed-scope]')).toBeNull();
      expect(ctrl.nativeHeaderProps).toMatchObject({ leftActionsStandalone: true });
      expect(ctrl.nativeHeaderProps?.title).toBeUndefined();
      expect(ctrl.nativeHeaderProps?.children).toBeUndefined();
    });

    it('hands UIKit the bell and find-climbers as native items, and keeps the glass avatar, on the iOS 26 iPhone', () => {
      ctrl.nativeHeader = true;
      ctrl.nativeBarItems = true;
      const onOpenSearch = vi.fn();
      render(<HomeTopChrome {...makeProps({ onOpenSearch })} />);

      // A horizontal bar keeps the glass avatar: round photo, initials without one.
      expect(ctrl.nativeHeaderProps?.leftItems).toBeUndefined();
      expect(ctrl.nativeHeaderProps?.leftActionsStandalone).toBe(true);
      const leading = render(<>{ctrl.nativeHeaderProps?.leftActions}</>).container;
      expect(leading.querySelector('[data-avatar-variant="glass"]')).not.toBeNull();

      const rightItems = ctrl.nativeHeaderProps?.rightItems?.() ?? [];
      expect(rightItems.map((item) => item.label)).toEqual(['notifications', 'searchLabel']);
      expect(rightItems[1]?.icon).toEqual({ type: 'sfSymbol', name: 'person.badge.plus' });

      rightItems[0]?.onPress?.();
      expect(routerMock.push).toHaveBeenCalledWith('/(tabs)/home/notifications');
      rightItems[1]?.onPress?.();
      expect(onOpenSearch).toHaveBeenCalledTimes(1);
    });

    it('leads with the native account item on the iPhone Duo rail', () => {
      ctrl.nativeHeader = true;
      ctrl.nativeBarItems = true;
      ctrl.onRail = true;
      render(<HomeTopChrome {...makeProps()} />);
      const leftItems = ctrl.nativeHeaderProps?.leftItems?.() ?? [];
      expect(leftItems.map((item) => item.label)).toEqual(['account']);
    });

    it('renders the floating glass chrome (blur + avatar/search islands + scope title)', () => {
      const { container } = render(<HomeTopChrome {...makeProps()} />);
      expect(container.querySelector('[data-blur]')).not.toBeNull();
      expect(container.querySelector('[data-avatar-variant="glass"]')).not.toBeNull();
      expect(container.querySelector('[data-feed-scope]')?.textContent).toBe('My crew');
      expect(searchAction(container)).not.toBeNull();
      // No M3 app bar on glass.
      expect(container.querySelector('[data-appbar-header]')).toBeNull();
    });

    it('shows a plain Home title, and keeps the header buttons, with nothing to scope', () => {
      const { container } = render(
        <HomeTopChrome {...makeProps({ showScopeMenu: false, scopeTitle: 'Home', scopeActions: [] })} />,
      );
      expect(container.querySelector('[data-feed-scope]')).toBeNull();
      const title = container.querySelector('[data-plain-title]');
      expect(title?.textContent).toBe('Home');
      expect(title?.getAttribute('role')).toBe('heading');
      expect(bell(container, 'glass')).not.toBeNull();
      expect(searchAction(container)).not.toBeNull();
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

    it('shows a plain Home app-bar title, and keeps the actions, with nothing to scope', () => {
      const { container } = render(
        <HomeTopChrome {...makeProps({ showScopeMenu: false, scopeTitle: 'Home', scopeActions: [] })} />,
      );
      expect(container.querySelector('[data-feed-scope]')).toBeNull();
      expect(container.querySelector('[data-appbar-content]')?.textContent).toBe('Home');
      expect(bell(container, 'material')).not.toBeNull();
      expect(searchAction(container)).not.toBeNull();
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
