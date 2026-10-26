// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, renderHook } from '@testing-library/react';
import type { ReactElement } from 'react';

type Board = { angle: number; isAngleAdjustable: boolean };
type ToolbarLightbulb = {
  available: boolean;
  lit: boolean;
  handlePress: () => void;
  accessibilityLabel: string;
};

const ctrl = vi.hoisted(() => ({
  openUserDrawer: vi.fn(),
  unread: 0,
  board: null as Board | null,
  openAngle: vi.fn(),
  lightbulb: {
    available: false,
    lit: false,
    handlePress: vi.fn(),
    accessibilityLabel: 'ble.connectBoard',
  } as ToolbarLightbulb,
  router: { push: vi.fn() },
  haptic: vi.fn(),
  onRail: false,
}));

vi.mock('expo-router', () => ({ useRouter: () => ctrl.router }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key),
  }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ brandColors: { primary: '#8B5CF6', warning: '#FF9500' } }),
}));
vi.mock('../../../lib/graphql/hooks/use-notifications', () => ({ useUnreadNotificationCount: () => ctrl.unread }));
vi.mock('../../../lib/graphql/use-active-board', () => ({ useActiveBoard: () => ({ data: ctrl.board }) }));
vi.mock('../../../lib/boards/active-board-label', () => ({
  formatActiveBoardLabel: (board: Board | null) => (board ? 'Kilter • M • 40°' : null),
}));
vi.mock('../../../lib/haptics', () => ({ hapticLight: ctrl.haptic }));
vi.mock('../../user-drawer/UserDrawerProvider', () => ({
  useUserDrawer: () => ({ openUserDrawer: ctrl.openUserDrawer }),
}));
vi.mock('../BoardAnglePicker', () => ({
  BoardAnglePicker: ({ children }: { children: (open: () => void) => ReactElement }) => children(ctrl.openAngle),
}));
vi.mock('../../../hooks/use-vertical-tab-bar', () => ({ useVerticalTabBar: () => ctrl.onRail }));
vi.mock('../LightbulbToolbarAction', () => ({ useToolbarLightbulb: () => ctrl.lightbulb }));

import {
  useAccountRailItem,
  useAngleBarItem,
  useBoardSwitcherBarItem,
  useClimbListBarItems,
  useLightbulbBarItem,
  useNotificationsBarItem,
} from '../use-root-bar-items';

const adjustable: Board = { angle: 40, isAngleAdjustable: true };

beforeEach(() => {
  ctrl.openUserDrawer.mockReset();
  ctrl.unread = 0;
  ctrl.board = null;
  ctrl.openAngle.mockReset();
  ctrl.lightbulb = { available: false, lit: false, handlePress: vi.fn(), accessibilityLabel: 'ble.connectBoard' };
  ctrl.router.push.mockReset();
  ctrl.haptic.mockReset();
  ctrl.onRail = false;
});

describe('useAccountRailItem', () => {
  it('is the account symbol titled like the drawer button, and opens the drawer', () => {
    const { result } = renderHook(() => useAccountRailItem());
    expect(result.current).toMatchObject({
      label: 'ariaLabels.userMenu',
      icon: { type: 'sfSymbol', name: 'person.crop.circle.badge.ellipsis' },
    });
    result.current.onPress();
    expect(ctrl.openUserDrawer).toHaveBeenCalledTimes(1);
  });
});

describe('useNotificationsBarItem', () => {
  it('is the bell at high priority, badged with the unread count', () => {
    ctrl.unread = 3;
    const { result } = renderHook(() => useNotificationsBarItem(vi.fn()));
    expect(result.current).toMatchObject({
      label: 'ariaLabels.notifications',
      icon: { type: 'sfSymbol', name: 'bell' },
      visibilityPriority: 'high',
      badge: { value: '3', style: { backgroundColor: '#8B5CF6' } },
      accessibilityLabel: 'ariaLabels.notifications (3)',
    });
  });

  it('drops the badge at zero and opens notifications with a haptic', () => {
    const open = vi.fn();
    const { result } = renderHook(() => useNotificationsBarItem(open));
    expect(result.current).not.toHaveProperty('badge');
    result.current.onPress();
    expect(ctrl.haptic).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe('useBoardSwitcherBarItem', () => {
  it('is absent without a board, and the grid named by the board otherwise', () => {
    const onPress = vi.fn();
    const { result, rerender } = renderHook(() => useBoardSwitcherBarItem({ onPress, badge: true }));
    expect(result.current).toBeNull();
    ctrl.board = adjustable;
    rerender();
    expect(result.current).toMatchObject({
      label: 'Kilter • M • 40°',
      icon: { type: 'sfSymbol', name: 'square.grid.2x2' },
      badge: { value: '' },
    });
    result.current?.onPress();
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe('useAngleBarItem', () => {
  function capture() {
    const seen: { current: ReturnType<typeof useAngleBarItem>['item'] } = { current: null };
    function Harness() {
      const { item, picker } = useAngleBarItem();
      seen.current = item;
      return picker;
    }
    render(<Harness />);
    return seen;
  }

  it('is the angle as its title and opens the picker that mounts beside the header', () => {
    ctrl.board = adjustable;
    const seen = capture();
    expect(seen.current).toMatchObject({
      label: '40°',
      accessibilityLabel: 'mobile.angleSelector.buttonAria {"angle":40}',
    });
    seen.current?.onPress();
    expect(ctrl.openAngle).toHaveBeenCalledTimes(1);
  });

  it('is absent for a fixed-angle board', () => {
    ctrl.board = { angle: 40, isAngleAdjustable: false };
    expect(capture().current).toBeNull();
  });
});

describe('useLightbulbBarItem', () => {
  it('is absent without Bluetooth', () => {
    const { result } = renderHook(() => useLightbulbBarItem());
    expect(result.current).toBeNull();
  });

  it('fills and tints the bulb while lit and runs the shared tap', () => {
    const handlePress = vi.fn();
    ctrl.lightbulb = { available: true, lit: true, handlePress, accessibilityLabel: 'lightControl.disconnect' };
    const { result } = renderHook(() => useLightbulbBarItem());
    expect(result.current).toMatchObject({
      label: 'lightControl.disconnect',
      icon: { type: 'sfSymbol', name: 'lightbulb.fill' },
      tintColor: '#FF9500',
    });
    result.current?.onPress();
    expect(handlePress).toHaveBeenCalledTimes(1);
  });
});

describe('useClimbListBarItems', () => {
  it('is history (standard priority, onboarding badge) then the list menu', () => {
    ctrl.board = adjustable;
    const onOpenHistory = vi.fn();
    const { result } = renderHook(() => useClimbListBarItems({ onOpenHistory, badge: true }));
    const [history, menu] = result.current;
    expect(history).toMatchObject({
      type: 'button',
      label: 'mobile.listOptions.historyTitle',
      icon: { type: 'sfSymbol', name: 'clock.arrow.circlepath' },
      visibilityPriority: 'standard',
      badge: { value: '' },
      accessibilityHint: 'mobile.listOptions.historyHint',
    });
    if (history?.type === 'button') history.onPress();
    expect(onOpenHistory).toHaveBeenCalledTimes(1);
    expect(ctrl.haptic).toHaveBeenCalledTimes(1);

    expect(menu).toMatchObject({ type: 'menu', label: 'mobile.listOptions.title', icon: { name: 'ellipsis' } });
    if (menu?.type !== 'menu') throw new Error('expected the list menu');
    const [viewOptions, switchBoard] = menu.menu.items;
    if (viewOptions?.type === 'action') viewOptions.onPress();
    if (switchBoard?.type === 'action') switchBoard.onPress();
    expect(ctrl.router.push.mock.calls).toEqual([['/(tabs)/climbs/settings/climb-list'], ['/boards']]);
  });

  it('puts the angle at the top of the menu when the bar has no room for it', () => {
    const openAngle = vi.fn();
    const { result } = renderHook(() =>
      useClimbListBarItems({
        onOpenHistory: vi.fn(),
        badge: false,
        angleRow: { label: 'Board angle, 40°', onPress: openAngle },
      }),
    );
    const menu = result.current.find((item) => item.type === 'menu');
    if (menu?.type !== 'menu') throw new Error('expected the list menu');
    const [angle] = menu.menu.items;
    expect(angle).toMatchObject({ label: 'Board angle, 40°', icon: { type: 'sfSymbol', name: 'angle' } });
    if (angle?.type === 'action') angle.onPress();
    expect(openAngle).toHaveBeenCalledTimes(1);
  });

  it('keeps only the menu without a board', () => {
    const { result } = renderHook(() => useClimbListBarItems({ onOpenHistory: vi.fn(), badge: false }));
    expect(result.current.map((item) => item.type)).toEqual(['menu']);
  });
});
