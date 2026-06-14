// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';

type BoardFields = Pick<
  UserBoard,
  'name' | 'angle' | 'boardType' | 'sizeName' | 'layoutName' | 'layoutId' | 'isAngleAdjustable'
>;
type BluetoothCtx = {
  isConnected: boolean;
  connect: () => Promise<boolean>;
  disconnect: () => Promise<void>;
  armUndoWallChangeToast: () => void;
} | null;

const ctrl = vi.hoisted(() => ({
  board: null as BoardFields | null,
  bluetooth: null as BluetoothCtx,
  setActiveBoard: vi.fn(),
}));
const haptics = vi.hoisted(() => ({ light: vi.fn() }));

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
        onClick: onLayout ? () => onLayout({ nativeEvent: { layout: { height: 64 } } }) : undefined,
      },
      children,
    ),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, absoluteFill: {}, hairlineWidth: 1 },
}));

vi.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-gradient': 'true' }, children),
}));
vi.mock('react-native-reanimated', () => ({
  default: {
    View: ({ children, pointerEvents }: { children?: ReactNode; pointerEvents?: string }) =>
      createElement('div', { 'data-pointer': pointerEvents ?? '' }, children),
  },
  Extrapolation: { CLAMP: 'clamp' },
  interpolate: () => 0,
  runOnJS: (fn: (...args: unknown[]) => unknown) => fn,
  useAnimatedReaction: () => {},
  useAnimatedStyle: () => ({}),
  useDerivedValue: () => ({ value: 0 }),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@boardsesh/board-config', () => ({ formatBoardDisplayName: (boardType: string) => `Display:${boardType}` }));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {
      label: '#000',
      secondaryLabel: '#888',
      separator: '#ccc',
      elevatedSurface: '#fff',
      background: '#fff',
    },
    brandColors: { warning: '#FF9500' },
  }),
}));
vi.mock('../../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: ctrl.board }),
  useSetActiveBoard: () => ctrl.setActiveBoard,
}));
vi.mock('../../../providers/bluetooth-provider', () => ({ useOptionalBluetoothContext: () => ctrl.bluetooth }));
vi.mock('../../../hooks/use-native-glass', () => ({ useNativeGlass: () => false }));
vi.mock('../../../lib/haptics', () => ({ hapticLight: haptics.light }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 4: 16 }, shadows: { sm: {} } }));
vi.mock('../../../theme/layout', () => ({ glassSize: { standard: 48, capsule: 44 } }));

vi.mock('../../GlassSurface', () => ({ GlassSurface: () => createElement('div', { 'data-glass': 'true' }) }));

type PressMockProps = {
  children?: ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
  accessibilityHint?: string;
};
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({ children, onPress, accessibilityLabel, accessibilityHint }: PressMockProps) =>
    createElement(
      'button',
      {
        onClick: onPress,
        'data-pressable': accessibilityLabel ?? '',
        'data-hint': accessibilityHint ?? '',
      },
      children,
    ),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({
  Icon: ({ name, color }: { name: string; color?: unknown }) =>
    createElement('span', { 'data-icon': name, 'data-color': typeof color === 'string' ? color : '' }),
}));
vi.mock('../../play-drawer/AngleSelectorSheet', () => ({
  AngleSelectorSheet: ({ visible }: { visible: boolean }) =>
    visible ? createElement('div', { 'data-angle-selector': 'true' }) : null,
}));
vi.mock('../../user-drawer/UserAvatarToolbarAction', () => ({
  UserAvatarToolbarAction: ({ variant }: { variant: 'glass' | 'material' }) =>
    createElement('button', { 'data-pressable': 'ariaLabels.userMenu', 'data-avatar-variant': variant }),
}));

import { CollapsingTopChrome } from '../CollapsingTopChrome';

const scrollY = { value: 0 } as unknown as Parameters<typeof CollapsingTopChrome>[0]['scrollY'];

function makeProps(over: Partial<Parameters<typeof CollapsingTopChrome>[0]> = {}) {
  return {
    title: 'All climbs',
    canCreate: false,
    onCreate: vi.fn(),
    createAccessibilityLabel: 'create.label',
    onOpenBoardSwitcher: vi.fn(),
    onHeightChange: vi.fn(),
    scrollY,
    onPressTitle: vi.fn(),
    ...over,
  };
}

const createAction = (root: HTMLElement) =>
  root.querySelector('[data-pressable="create.label"]') as HTMLButtonElement | null;
const lightbulb = (root: HTMLElement) =>
  (root.querySelector('[data-pressable="ble.connectBoard"]') ??
    root.querySelector('[data-pressable="lightControl.disconnect"]')) as HTMLButtonElement | null;
const centeredBoardPill = (root: HTMLElement, label = 'Display:kilter • M • 40°') =>
  (Array.from(root.querySelectorAll<HTMLButtonElement>('[data-pressable]')).find(
    (element) => element.getAttribute('data-pressable') === label && element.textContent?.includes(label),
  ) ?? null) as HTMLButtonElement | null;
const boardGlyph = (root: HTMLElement, label = 'Display:kilter • M • 40°') =>
  (Array.from(root.querySelectorAll<HTMLButtonElement>('[data-pressable]')).find(
    (element) => element.getAttribute('data-pressable') === label && !element.textContent?.includes(label),
  ) ?? null) as HTMLButtonElement | null;

const board: BoardFields = {
  name: '',
  angle: 40,
  boardType: 'kilter',
  sizeName: 'M',
  layoutName: 'Kilter Layout',
  layoutId: 1,
  isAngleAdjustable: true,
};

describe('CollapsingTopChrome', () => {
  beforeEach(() => {
    ctrl.board = null;
    ctrl.bluetooth = null;
    haptics.light.mockClear();
  });

  it('renders the board pill for the active board', () => {
    ctrl.board = board;
    const { container } = render(<CollapsingTopChrome {...makeProps()} />);
    expect(centeredBoardPill(container)?.getAttribute('data-pressable')).toBe('Display:kilter • M • 40°');
  });

  it('renders no board pill when there is no active board', () => {
    const { container } = render(<CollapsingTopChrome {...makeProps()} />);
    expect(centeredBoardPill(container)).toBeNull();
  });

  it('opens the board switcher when the pill is pressed', () => {
    ctrl.board = board;
    const onOpenBoardSwitcher = vi.fn();
    const { container } = render(<CollapsingTopChrome {...makeProps({ onOpenBoardSwitcher })} />);
    fireEvent.click(centeredBoardPill(container)!);
    expect(onOpenBoardSwitcher).toHaveBeenCalledTimes(1);
  });

  it('uses only the compact board glyph when compactBoardControl is set', () => {
    ctrl.board = board;
    const onOpenBoardSwitcher = vi.fn();
    const { container } = render(
      <CollapsingTopChrome
        {...makeProps({
          title: 'Session',
          boardPillAccessibilityHint: 'Opens board switcher',
          compactBoardControl: true,
          onOpenBoardSwitcher,
        })}
      />,
    );

    expect(centeredBoardPill(container)).toBeNull();
    const glyph = boardGlyph(container);
    expect(glyph).not.toBeNull();
    expect(glyph?.getAttribute('data-hint')).toBe('Opens board switcher');
    fireEvent.click(glyph!);
    expect(onOpenBoardSwitcher).toHaveBeenCalledTimes(1);
    expect(haptics.light).toHaveBeenCalledTimes(1);
  });

  it('uses persistent center content instead of the centered board pill', () => {
    ctrl.board = board;
    const { container } = render(
      <CollapsingTopChrome
        {...makeProps({
          persistentCenterContent: createElement('div', { 'data-testid': 'timer' }),
        })}
      />,
    );

    expect(container.querySelector('[data-testid="timer"]')).not.toBeNull();
    expect(centeredBoardPill(container)).toBeNull();
    expect(boardGlyph(container)).toBeNull();
    expect(container.querySelector('[data-avatar-variant="glass"]')).toBeNull();
    expect(container.querySelector('[data-pressable="mobile.angleSelector.title"]')).toBeNull();
  });

  it('uses the persistent title instead of board and angle controls', () => {
    ctrl.board = board;
    const { container } = render(<CollapsingTopChrome {...makeProps({ persistentTitle: true })} />);

    expect(container.querySelector('[data-pressable="All climbs"]')).not.toBeNull();
    expect(centeredBoardPill(container)).toBeNull();
    expect(boardGlyph(container)).toBeNull();
    expect(container.querySelector('[data-avatar-variant="glass"]')).toBeNull();
    expect(container.querySelector('[data-pressable="mobile.angleSelector.title"]')).toBeNull();
  });

  it('gates the create action on canCreate and fires onCreate with its label', () => {
    ctrl.board = board;
    const onCreate = vi.fn();
    const { container, rerender } = render(<CollapsingTopChrome {...makeProps({ canCreate: false, onCreate })} />);
    expect(createAction(container)).toBeNull();
    rerender(<CollapsingTopChrome {...makeProps({ canCreate: true, onCreate })} />);
    fireEvent.click(createAction(container)!);
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('docks a board glyph labelled by the active board into the toolbar, opening the switcher', () => {
    ctrl.board = board;
    const onOpenBoardSwitcher = vi.fn();
    const { container } = render(<CollapsingTopChrome {...makeProps({ title: 'V4–V6', onOpenBoardSwitcher })} />);
    const glyph = boardGlyph(container);
    expect(glyph).not.toBeNull();
    fireEvent.click(glyph!);
    expect(onOpenBoardSwitcher).toHaveBeenCalledTimes(1);
  });

  it('shows the lightbulb only when bluetooth is available', () => {
    ctrl.board = board;
    const { container, rerender } = render(<CollapsingTopChrome {...makeProps()} />);
    expect(lightbulb(container)).toBeNull();

    ctrl.bluetooth = {
      isConnected: true,
      connect: vi.fn(),
      disconnect: vi.fn().mockResolvedValue(undefined),
      armUndoWallChangeToast: vi.fn(),
    };
    rerender(<CollapsingTopChrome {...makeProps()} />);
    expect(lightbulb(container)).not.toBeNull();
    expect(container.querySelector('[data-icon="lightbulb.fill"]')?.getAttribute('data-color')).toBe('#FF9500');
  });

  it('hides the lightbulb when hideLight is set, even with bluetooth available', () => {
    ctrl.board = board;
    ctrl.bluetooth = {
      isConnected: true,
      connect: vi.fn(),
      disconnect: vi.fn().mockResolvedValue(undefined),
      armUndoWallChangeToast: vi.fn(),
    };
    const { container } = render(<CollapsingTopChrome {...makeProps({ hideLight: true })} />);
    expect(lightbulb(container)).toBeNull();
  });

  it('docks a leading action in the left island', () => {
    ctrl.board = board;
    const { container } = render(
      <CollapsingTopChrome
        {...makeProps({
          leadingAction: createElement('button', { 'data-leading': 'invite' }),
          leadingActionCount: 1,
        })}
      />,
    );
    expect(container.querySelector('[data-leading="invite"]')).not.toBeNull();
  });

  it('widens the right island for a multi-slot trailing action (trailingActionCount)', () => {
    const { container } = render(
      <CollapsingTopChrome
        {...makeProps({
          trailingAction: createElement('button', { 'data-trailing': 'stop' }),
          trailingActionCount: 2,
        })}
      />,
    );
    // The two-slot count widens the right toolbar past zero, so the Stop pill renders.
    expect(container.querySelector('[data-trailing="stop"]')).not.toBeNull();
  });

  it('respects an explicit trailingActionCount of 0 (the ?? guard, not ||)', () => {
    const { container } = render(
      <CollapsingTopChrome
        {...makeProps({
          trailingAction: createElement('button', { 'data-trailing': 'stop' }),
          trailingActionCount: 0,
        })}
      />,
    );
    // A `||` instead of `??` would let the phantom element widen the toolbar to one
    // slot and render; `??` honours the explicit 0, so the right island stays empty.
    expect(container.querySelector('[data-trailing="stop"]')).toBeNull();
  });

  it('renders the children slot (e.g. the search row)', () => {
    const { container } = render(
      <CollapsingTopChrome {...makeProps()}>
        {createElement('div', { 'data-testid': 'search-row' })}
      </CollapsingTopChrome>,
    );
    expect(container.querySelector('[data-testid="search-row"]')).not.toBeNull();
  });

  it('reports its measured height through onHeightChange', () => {
    const onHeightChange = vi.fn();
    const { container } = render(<CollapsingTopChrome {...makeProps({ onHeightChange })} />);
    fireEvent.click(container.querySelector('[data-has-layout="true"]') as HTMLElement);
    expect(onHeightChange).toHaveBeenCalledWith(64);
  });
});
