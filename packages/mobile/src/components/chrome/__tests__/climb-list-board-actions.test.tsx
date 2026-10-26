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
  isTablet: false,
  widthClass: 'compact',
  os: 'ios',
  push: vi.fn(),
  change: vi.fn(),
  haptic: vi.fn(),
  picker: null as PickerProps | null,
  menusMounted: 0,
  menu: null as AppMenuProps | null,
  actionSize: 38,
  iconSizes: {} as Record<string, number>,
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
      if (key === 'mobile.angleSelector.buttonAria') return `Board angle, ${options?.angle}°`;
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
  useDeviceLayout: () => ({ isPad: state.isPad, isTablet: state.isTablet, widthClass: state.widthClass }),
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
vi.mock('../GlassActionToolbar', () => ({
  GlassToolbarAction: MockAction,
  useToolbarActionSize: () => state.actionSize,
  // The real scaling is covered in native-root-header.test.tsx.
  toolbarGlyphSize: (baseSize: number, actionSize: number) => Math.round(baseSize * Math.min(1, actionSize / 44)),
}));
vi.mock('../../LargeContentViewer', () => ({
  LargeContentViewer: ({
    children,
    title,
    onActivate,
  }: {
    children?: ReactNode;
    title: string;
    onActivate?: () => void;
  }) => createElement('span', { 'data-viewer-title': title, onContextMenu: onActivate }, children),
}));
vi.mock('react-native-paper', () => ({
  Appbar: {
    Action: MockAction,
    Content: ({ title }: { title: string }) => createElement('span', { 'data-board-title': true }, title),
  },
}));
vi.mock('../../Icon', () => ({
  Icon: ({ name, size }: { name: string; size: number }) => {
    state.iconSizes[name] = size;
    return createElement('span', { 'data-icon': name });
  },
}));
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

import { ClimbListBoardActions, ClimbListBoardTitle, climbListBoardActionCount } from '../ClimbListBoardActions';

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
  state.isTablet = false;
  state.widthClass = 'compact';
  state.os = 'ios';
  state.push.mockReset();
  state.change.mockReset();
  state.haptic.mockReset();
  state.picker = null;
  state.menu = null;
  state.menusMounted = 0;
  state.actionSize = 38;
  state.iconSizes = {};
});

describe('Climb list angle, history and options', () => {
  it('leads with the one-tap angle, then labelled history, then the two-row native menu', () => {
    const openHistory = vi.fn();
    const { getByRole, container } = render(<ClimbListBoardActions onOpenHistory={openHistory} badge showcaseAnchor />);
    const angle = getByRole('button', { name: 'Board angle, 35°' });
    expect(angle.textContent).toBe('35°');
    const history = getByRole('button', { name: 'Board history, Garage wall • 35°' });
    expect(history.getAttribute('data-hint')).toBe('mobile.listOptions.historyHint');
    expect(history.querySelector('[data-icon="history"]')).not.toBeNull();
    expect(container.querySelector('[data-showcase="board-history-button"]')?.contains(history)).toBe(true);
    expect(container.querySelector('[data-showcase="board-history-button"]')?.contains(angle)).toBe(false);
    expect(container.querySelector('[data-badge]')).not.toBeNull();
    // Angle sits inboard: first in the trailing group, before history and the menu.
    const buttons = [...container.querySelectorAll<HTMLElement>('button')];
    expect(buttons.indexOf(angle)).toBe(0);
    expect(buttons.indexOf(history)).toBe(1);
    expect(angle.compareDocumentPosition(container.querySelector('[data-menu]')!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(state.menu).toMatchObject({ iconName: 'more', iconAppearance: 'plain', anchorSize: 38 });
    expect(state.menu?.actions.map(({ label }) => label)).toEqual([
      'mobile.listOptions.viewOptions',
      'mobile.boardPresence.switchBoard',
    ]);
    expect(state.menu?.actions[0].dividerBefore).toBeUndefined();
    expect(state.menu?.actions[1].dividerBefore).toBe(true);
    expect(state.iconSizes.history).toBe(20);
    fireEvent.click(history);
    expect(openHistory).toHaveBeenCalledOnce();
    expect(state.haptic).toHaveBeenCalledOnce();
  });

  it('shows the angle in the Large Content Viewer under its spoken label, and opens the picker from there', () => {
    const { container, getByRole, queryByRole } = render(<ClimbListBoardActions onOpenHistory={vi.fn()} />);
    const viewer = container.querySelector('[data-viewer-title="Board angle, 35°"]')!;
    expect(getByRole('button', { name: 'Board angle, 35°' }).contains(viewer)).toBe(true);
    expect(viewer.textContent).toBe('35°');
    expect(queryByRole('button', { name: 'Apply angle' })).toBeNull();
    fireEvent.contextMenu(viewer);
    expect(getByRole('button', { name: 'Apply angle' })).not.toBeNull();
  });

  it.each(['fixed', 'missing angle', 'missing board'])(
    'drops the angle and keeps menu destinations with %s',
    (scenario) => {
      if (scenario === 'fixed') state.board = { ...BOARD, isAngleAdjustable: false };
      if (scenario === 'missing angle') state.board = { ...BOARD, angle: null as unknown as number };
      if (scenario === 'missing board') state.board = null;
      const { getByRole, queryByRole, queryByText } = render(<ClimbListBoardActions onOpenHistory={vi.fn()} />);
      expect(queryByRole('button', { name: /Board angle/ })).toBeNull();
      expect(queryByText('35°')).toBeNull();
      expect(state.menu?.actions).toHaveLength(2);
      fireEvent.click(getByRole('button', { name: 'mobile.listOptions.viewOptions' }));
      fireEvent.click(getByRole('button', { name: 'mobile.boardPresence.switchBoard' }));
      expect(state.push.mock.calls).toEqual([['/(tabs)/climbs/settings/climb-list'], ['/boards']]);
    },
  );

  it('offers no angle row in the menu on any platform', () => {
    for (const material of [false, true]) {
      const { unmount } = render(<ClimbListBoardActions material={material} onOpenHistory={vi.fn()} />);
      expect(state.menu?.actions.map(({ label }) => label)).toEqual([
        'mobile.listOptions.viewOptions',
        'mobile.boardPresence.switchBoard',
      ]);
      unmount();
    }
  });

  it('offers the full-screen Wall display on a tablet, between View options and Switch board', () => {
    state.isPad = true;
    state.isTablet = true;
    const { getByRole } = render(<ClimbListBoardActions onOpenHistory={vi.fn()} />);
    expect(state.menu?.actions.map(({ label }) => label)).toEqual([
      'mobile.listOptions.viewOptions',
      'mobile.boardPresence.wallDisplay.open',
      'mobile.boardPresence.switchBoard',
    ]);
    // Switch board still opens its own group.
    expect(state.menu?.actions[2].dividerBefore).toBe(true);
    fireEvent.click(getByRole('button', { name: 'mobile.boardPresence.wallDisplay.open' }));
    expect(state.push).toHaveBeenCalledExactlyOnceWith('/wall-display');
  });

  it('cancels a phone picker without saving and applies only after confirmation', () => {
    const { getByRole, queryByRole } = render(<ClimbListBoardActions onOpenHistory={vi.fn()} />);
    fireEvent.click(getByRole('button', { name: 'Board angle, 35°' }));
    fireEvent.click(getByRole('button', { name: 'Cancel angle' }));
    expect(state.change).not.toHaveBeenCalled();
    expect(queryByRole('button', { name: 'Apply angle' })).toBeNull();
    fireEvent.click(getByRole('button', { name: 'Board angle, 35°' }));
    fireEvent.click(getByRole('button', { name: 'Apply angle' }));
    expect(state.change).toHaveBeenCalledExactlyOnceWith(state.board, 45);
  });

  it('dismisses an open picker on board changes and refuses its stale callback', () => {
    const { getByRole, rerender, queryByRole } = render(<ClimbListBoardActions onOpenHistory={vi.fn()} />);
    fireEvent.click(getByRole('button', { name: 'Board angle, 35°' }));
    const staleChange = state.picker?.onAngleChange;
    state.board = { ...BOARD, uuid: 'board-b', angle: 40 };
    rerender(<ClimbListBoardActions onOpenHistory={vi.fn()} />);
    expect(queryByRole('button', { name: 'Apply angle' })).toBeNull();
    staleChange?.(45);
    expect(state.change).not.toHaveBeenCalled();
    expect(state.menusMounted).toBe(2);
    fireEvent.click(getByRole('button', { name: 'Board angle, 40°' }));
    fireEvent.click(getByRole('button', { name: 'Apply angle' }));
    expect(state.change).toHaveBeenCalledExactlyOnceWith(state.board, 45);
  });

  it('anchors the regular-width iPad popover on the angle button, not the menu, and discards preview on cancel', () => {
    state.isPad = true;
    state.widthClass = 'regular';
    const { getByRole, container } = render(<ClimbListBoardActions onOpenHistory={vi.fn()} />);
    const anchor = container.querySelector('[data-popover-anchor]')!;
    expect(anchor.contains(getByRole('button', { name: 'Board angle, 35°' }))).toBe(true);
    expect(anchor.contains(container.querySelector('[data-menu]'))).toBe(false);
    expect(anchor.contains(getByRole('button', { name: 'Board history, Garage wall • 35°' }))).toBe(false);
    fireEvent.click(getByRole('button', { name: 'Board angle, 35°' }));
    expect(container.querySelector('[data-ipad-picker]')).not.toBeNull();
    expect(state.menusMounted).toBe(1);
    fireEvent.click(getByRole('button', { name: 'Preview 45' }));
    fireEvent.click(getByRole('button', { name: 'Dismiss popover' }));
    expect(state.change).not.toHaveBeenCalled();
    fireEvent.click(getByRole('button', { name: 'Board angle, 35°' }));
    expect(container.querySelector('[data-preview]')?.getAttribute('data-preview')).toBe('35');
    fireEvent.click(getByRole('button', { name: 'Preview 45' }));
    fireEvent.click(getByRole('button', { name: 'Apply angle' }));
    expect(state.change).toHaveBeenCalledExactlyOnceWith(state.board, 45);
    expect(state.menusMounted).toBe(1);
  });

  it('leaves the Material angle to the filter chip: no angle button, M3 menu target, angle off the title', () => {
    state.os = 'android';
    const openHistory = vi.fn();
    const { getByRole, queryByRole, container } = render(
      <>
        <ClimbListBoardTitle />
        <ClimbListBoardActions material onOpenHistory={openHistory} />
      </>,
    );
    expect(queryByRole('button', { name: /Board angle/ })).toBeNull();
    expect(state.menu?.anchorSize).toBeUndefined();
    expect(container.querySelector('[data-board-title]')?.textContent).toBe('Garage wall');
    fireEvent.click(getByRole('button', { name: 'Board history, Garage wall • 35°' }));
    expect(openHistory).toHaveBeenCalledOnce();
  });

  it('keeps the angle in the Material title of a fixed-angle board, which has no chip', () => {
    state.board = { ...BOARD, isAngleAdjustable: false };
    const { container } = render(<ClimbListBoardTitle />);
    expect(container.querySelector('[data-board-title]')?.textContent).toBe('Garage wall • 35°');
  });
});

describe('climbListBoardActionCount', () => {
  it.each([
    ['no board', null, 1],
    ['an adjustable board', BOARD, 3],
    ['a fixed-angle board', { ...BOARD, isAngleAdjustable: false }, 2],
    ['a board with no angle', { ...BOARD, angle: null as unknown as number }, 2],
  ] as const)('counts the glass slots for %s', (_label, board, count) => {
    expect(climbListBoardActionCount(board)).toBe(count);
  });

  it.each([
    ['no board', null],
    ['an adjustable board', BOARD],
    ['a fixed-angle board', { ...BOARD, isAngleAdjustable: false }],
    ['a board with no angle', { ...BOARD, angle: null as unknown as number }],
  ] as const)('matches the slots the glass toolbar renders for %s', (_label, board) => {
    state.board = board;
    const { container } = render(<ClimbListBoardActions onOpenHistory={vi.fn()} />);
    // One slot each for the angle, history and the menu that actually render.
    const slots =
      container.querySelectorAll('button[aria-label^="Board angle"]').length +
      container.querySelectorAll('button[aria-label^="Board history"]').length +
      container.querySelectorAll('[data-menu]').length;
    expect(slots).toBe(climbListBoardActionCount(board));
  });
});
