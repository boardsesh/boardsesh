// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { createElement, useEffect, type ReactElement, type ReactNode } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { AppMenuProps } from '../../AppMenu.types';

type Board = Pick<
  UserBoard,
  'uuid' | 'boardType' | 'layoutId' | 'sizeId' | 'setIds' | 'angle' | 'isAngleAdjustable' | 'name'
>;
type PickerProps = { visible: boolean; onClose: () => void; onAngleChange: (angle: number) => void };
const state = vi.hoisted(() => ({
  board: null as Board | null,
  isPad: false,
  widthClass: 'compact',
  os: 'ios',
  push: vi.fn(),
  change: vi.fn(),
  haptic: vi.fn(),
  picker: null as PickerProps | null,
  menusMounted: 0,
  menu: null as AppMenuProps | null,
}));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return state.os;
    },
  },
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: state.push }) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { board?: string; angle?: number }) => {
      if (key === 'mobile.listOptions.history') return `Board history, ${options?.board}`;
      if (key === 'mobile.listOptions.angle') return `Angle · ${options?.angle}°`;
      return key;
    },
  }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { label: '#fff' }, brandColors: { primary: '#c54' } }),
}));
vi.mock('@boardsesh/board-config', () => ({ formatBoardDisplayName: (boardType: string) => boardType }));
vi.mock('../../../lib/graphql/use-active-board', () => ({ useActiveBoard: () => ({ data: state.board }) }));
vi.mock('../../../lib/boards/use-set-board-angle', () => ({ useSetBoardAngle: () => state.change }));
vi.mock('../../../lib/haptics', () => ({ hapticLight: state.haptic }));
vi.mock('../../../hooks/use-device-layout', () => ({
  useDeviceLayout: () => ({ isPad: state.isPad, widthClass: state.widthClass }),
}));
vi.mock('../../../hooks/use-board-angle-options', () => ({ useBoardAngleOptions: () => [30, 35, 40, 45] }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 4: 16 } }));
vi.mock('../../../lib/showcase-anchor', () => ({
  ShowcaseAnchorView: ({ children, name, enabled }: { children: ReactNode; name: string; enabled: boolean }) =>
    createElement('div', { 'data-showcase': enabled ? name : undefined }, children),
}));
type ActionProps = {
  children?: ReactNode;
  onPress: () => void;
  accessibilityLabel: string;
  accessibilityHint?: string;
};
function MockAction({ children, onPress, accessibilityLabel, accessibilityHint }: ActionProps) {
  return createElement(
    'button',
    { onClick: onPress, 'aria-label': accessibilityLabel, 'data-hint': accessibilityHint },
    children,
  );
}
vi.mock('../GlassActionToolbar', () => ({ GlassToolbarAction: MockAction, useToolbarActionSize: () => 44 }));
vi.mock('react-native-paper', () => ({
  Appbar: {
    Action: MockAction,
    Content: ({ title }: { title: string }) => createElement('span', { 'data-board-title': true }, title),
  },
}));
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }) }));
vi.mock('../../Badge', () => ({ Badge: () => createElement('span', { 'data-badge': true }) }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../AppMenu', () => ({
  AppMenu: (props: AppMenuProps) => {
    state.menu = props;
    useEffect(() => {
      state.menusMounted += 1;
    }, []);
    return createElement(
      'div',
      { 'data-menu': props.accessibilityLabel },
      props.actions.map((action, index) =>
        createElement('button', { key: action.label, onClick: () => props.onSelectIndex(index) }, action.label),
      ),
    );
  },
}));
vi.mock('../../play-drawer/AngleSelectorSheet', () => ({
  AngleSelectorSheet: (props: PickerProps) => {
    state.picker = props;
    return props.visible
      ? createElement(
          'div',
          { 'data-phone-picker': true },
          createElement('button', { onClick: props.onClose }, 'Cancel angle'),
          createElement(
            'button',
            {
              onClick: () => {
                props.onAngleChange(45);
                props.onClose();
              },
            },
            'Apply angle',
          ),
        )
      : null;
  },
}));
vi.mock('../../navigation/AnchoredPopover', () => ({
  AnchoredPopover: ({
    trigger,
    content,
    visible,
    onClose,
  }: {
    trigger: ReactElement;
    content: ReactElement;
    visible: boolean;
    onClose: () => void;
  }) =>
    createElement(
      'div',
      { 'data-popover-anchor': true },
      trigger,
      visible
        ? createElement(
            'div',
            { 'data-ipad-picker': true },
            content,
            createElement('button', { onClick: onClose }, 'Dismiss popover'),
          )
        : null,
    ),
}));
vi.mock('../../SheetTopBar', () => ({
  SheetTopBar: ({ leading, trailing }: { leading: { onPress: () => void }; trailing: { onPress: () => void } }) =>
    createElement(
      'div',
      null,
      createElement('button', { onClick: leading.onPress }, 'Cancel angle'),
      createElement('button', { onClick: trailing.onPress }, 'Apply angle'),
    ),
}));
vi.mock('../../play-drawer/AngleBoardDiagram', () => ({ AngleBoardDiagram: () => null }));
vi.mock('../../play-drawer/AngleSlider', () => ({
  AngleSlider: ({ value, onChange }: { value: number; onChange: (angle: number) => void }) =>
    createElement('button', { onClick: () => onChange(45), 'data-preview': value }, 'Preview 45'),
}));

import { ClimbListBoardActions, ClimbListBoardTitle } from '../ClimbListBoardActions';

const BOARD: Board = {
  uuid: 'board-a',
  boardType: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: '1,2',
  angle: 35,
  isAngleAdjustable: true,
  name: 'Garage wall',
};

beforeEach(() => {
  state.board = { ...BOARD };
  state.isPad = false;
  state.widthClass = 'compact';
  state.os = 'ios';
  state.push.mockReset();
  state.change.mockReset();
  state.haptic.mockReset();
  state.picker = null;
  state.menu = null;
  state.menusMounted = 0;
});

describe('Climb list history and options', () => {
  it('keeps labelled history before the native menu, including its badge and showcase anchor', () => {
    const openHistory = vi.fn();
    const { getByRole, container } = render(<ClimbListBoardActions onOpenHistory={openHistory} badge showcaseAnchor />);
    const history = getByRole('button', { name: 'Board history, Garage wall • 35°' });
    expect(history.getAttribute('data-hint')).toBe('mobile.listOptions.historyHint');
    expect(history.querySelector('[data-icon="history"]')).not.toBeNull();
    expect(container.querySelector('[data-showcase="board-history-button"]')?.contains(history)).toBe(true);
    expect(container.querySelector('[data-badge]')).not.toBeNull();
    expect(container.querySelector('button')).toBe(history);
    expect(state.menu).toMatchObject({ iconName: 'more', iconAppearance: 'plain' });
    expect(state.menu?.actions.map(({ label }) => label)).toEqual([
      'Angle · 35°',
      'mobile.listOptions.viewOptions',
      'mobile.boardPresence.switchBoard',
    ]);
    expect(state.menu?.actions[2].dividerBefore).toBe(true);
    fireEvent.click(history);
    expect(openHistory).toHaveBeenCalledOnce();
    expect(state.haptic).toHaveBeenCalledOnce();
  });

  it.each(['fixed', 'missing angle', 'missing board'])('keeps menu destinations correct with %s', (scenario) => {
    if (scenario === 'fixed') state.board = { ...BOARD, isAngleAdjustable: false };
    if (scenario === 'missing angle') state.board = { ...BOARD, angle: null as unknown as number };
    if (scenario === 'missing board') state.board = null;
    const { getByRole, queryByText } = render(<ClimbListBoardActions onOpenHistory={vi.fn()} />);
    expect(queryByText('Angle · 35°')).toBeNull();
    expect(state.menu?.actions).toHaveLength(2);
    fireEvent.click(getByRole('button', { name: 'mobile.listOptions.viewOptions' }));
    fireEvent.click(getByRole('button', { name: 'mobile.boardPresence.switchBoard' }));
    expect(state.push.mock.calls).toEqual([['/(tabs)/climbs/settings/climb-list'], ['/boards']]);
  });

  it('cancels a phone picker without saving and applies only after confirmation', () => {
    const { getByRole, queryByRole } = render(<ClimbListBoardActions onOpenHistory={vi.fn()} />);
    fireEvent.click(getByRole('button', { name: 'Angle · 35°' }));
    fireEvent.click(getByRole('button', { name: 'Cancel angle' }));
    expect(state.change).not.toHaveBeenCalled();
    expect(queryByRole('button', { name: 'Apply angle' })).toBeNull();
    fireEvent.click(getByRole('button', { name: 'Angle · 35°' }));
    fireEvent.click(getByRole('button', { name: 'Apply angle' }));
    expect(state.change).toHaveBeenCalledExactlyOnceWith(state.board, 45);
  });

  it('dismisses an open picker on board changes and refuses its stale callback', () => {
    const { getByRole, rerender, queryByRole } = render(<ClimbListBoardActions onOpenHistory={vi.fn()} />);
    fireEvent.click(getByRole('button', { name: 'Angle · 35°' }));
    const staleChange = state.picker?.onAngleChange;
    state.board = { ...BOARD, uuid: 'board-b', angle: 40 };
    rerender(<ClimbListBoardActions onOpenHistory={vi.fn()} />);
    expect(queryByRole('button', { name: 'Apply angle' })).toBeNull();
    staleChange?.(45);
    expect(state.change).not.toHaveBeenCalled();
    expect(state.menusMounted).toBe(2);
    fireEvent.click(getByRole('button', { name: 'Angle · 40°' }));
    fireEvent.click(getByRole('button', { name: 'Apply angle' }));
    expect(state.change).toHaveBeenCalledExactlyOnceWith(state.board, 45);
  });

  it('anchors the first regular-width iPad picker without remounting its menu, and discards preview on cancel', () => {
    state.isPad = true;
    state.widthClass = 'regular';
    const { getByRole, container } = render(<ClimbListBoardActions onOpenHistory={vi.fn()} />);
    expect(container.querySelector('[data-popover-anchor]')).not.toBeNull();
    fireEvent.click(getByRole('button', { name: 'Angle · 35°' }));
    expect(container.querySelector('[data-ipad-picker]')).not.toBeNull();
    expect(state.menusMounted).toBe(1);
    fireEvent.click(getByRole('button', { name: 'Preview 45' }));
    fireEvent.click(getByRole('button', { name: 'Dismiss popover' }));
    expect(state.change).not.toHaveBeenCalled();
    fireEvent.click(getByRole('button', { name: 'Angle · 35°' }));
    expect(container.querySelector('[data-preview]')?.getAttribute('data-preview')).toBe('35');
    fireEvent.click(getByRole('button', { name: 'Preview 45' }));
    fireEvent.click(getByRole('button', { name: 'Apply angle' }));
    expect(state.change).toHaveBeenCalledExactlyOnceWith(state.board, 45);
    expect(state.menusMounted).toBe(1);
  });

  it('keeps the Material board title static and history independently tappable', () => {
    state.os = 'android';
    const openHistory = vi.fn();
    const { getByRole, container } = render(
      <>
        <ClimbListBoardTitle />
        <ClimbListBoardActions material onOpenHistory={openHistory} />
      </>,
    );
    expect(container.querySelector('[data-board-title]')?.textContent).toBe('Garage wall • 35°');
    fireEvent.click(getByRole('button', { name: 'Board history, Garage wall • 35°' }));
    expect(openHistory).toHaveBeenCalledOnce();
  });
});
