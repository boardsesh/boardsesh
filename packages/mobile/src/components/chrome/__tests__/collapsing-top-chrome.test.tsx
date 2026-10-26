// @vitest-environment jsdom
vi.mock('../../../hooks/use-native-root-bar-items', () => ({ useNativeRootBarItems: () => ctrl.nativeBarItems }));
// The live item hooks have their own suite; here they hand back labelled stand-ins
// so the chrome's ordering and gating can be read off the items it passes UIKit.
vi.mock('../use-root-bar-items', () => {
  const stub = (label: string, identifier?: string) => ({
    type: 'button' as const,
    label,
    onPress: () => undefined,
    ...(identifier ? { identifier } : {}),
  });
  return {
    useAccountRailItem: () => stub('account'),
    useAngleBarItem: ({ onPickerOpenChange }: { onPickerOpenChange?: (open: boolean) => void } = {}) => {
      // The chrome's listener, so a test can open and close the picker it would mount.
      ctrl.anglePickerOpenChange = onPickerOpenChange ?? null;
      return {
        item: ctrl.board?.isAngleAdjustable ? { ...stub('40°'), accessibilityLabel: 'Board angle, 40°' } : null,
        picker: createElement('div', { 'data-native-angle-picker': 'true' }),
      };
    },
    useBoardSwitcherBarItem: () => (ctrl.board ? stub('board') : null),
    useClimbListBarItems: ({ angleRow }: { angleRow?: { label: string } | null }) => {
      ctrl.climbListAngleRow = angleRow ?? null;
      return [stub('history', 'root.boardHistory'), stub('list-menu')];
    },
    useLightbulbBarItem: () => (ctrl.bluetooth ? stub('lightbulb') : null),
    useBarItemsOnRail: () => ctrl.onRail,
  };
});
vi.mock('../NativeTrailingItemShowcaseAnchor', () => ({
  NativeTrailingItemShowcaseAnchor: ({ name, positionFromEnd }: { name: string; positionFromEnd: number }) =>
    createElement('div', { 'data-native-anchor': name, 'data-position-from-end': positionFromEnd }),
}));
vi.mock('../../SheetTopBar', () => ({ SheetTopBar: () => null }));
vi.mock('../../../hooks/use-native-root-header', () => ({ useNativeRootHeader: () => ctrl.nativeHeader }));
vi.mock('../../chrome/NativeRootHeader', () => ({
  NativeRootHeader: ({
    centerContent,
    centerActionWidths,
    centerItemSides,
    children,
    leftActions,
    leftItems,
    rightItems,
    scrollEdge,
  }: {
    centerContent?: ReactNode;
    centerActionWidths?: { leading: number; trailing: number };
    centerItemSides?: ItemSides;
    children?: ReactNode;
    leftActions?: ReactNode;
    leftItems?: () => BarItemStandIn[];
    rightItems?: () => BarItemStandIn[];
    scrollEdge?: unknown;
  }) => {
    ctrl.nativeScrollEdge = scrollEdge;
    ctrl.nativeLeftActions = leftActions;
    ctrl.nativeLeftItems = leftItems?.() ?? null;
    ctrl.nativeRightItems = rightItems?.() ?? null;
    ctrl.nativeCenterActionWidths = centerActionWidths;
    ctrl.nativeCenterItemSides = centerItemSides;
    return createElement(
      'div',
      null,
      createElement('div', { 'data-native-center': 'true' }, centerContent),
      createElement('div', { 'data-native-controls': 'true' }, children),
    );
  },
}));
vi.mock('../../../hooks/use-device-layout', () => ({
  useDeviceLayout: () => ({ isPad: ctrl.isPad, widthClass: ctrl.widthClass }),
}));
vi.mock('../../../hooks/use-board-angle-options', () => ({ useBoardAngleOptions: () => [30, 40] }));
vi.mock('../../navigation/AnchoredPopover', () => ({
  AnchoredPopover: ({ trigger }: { trigger: ReactNode }) => trigger,
}));
vi.mock('../../play-drawer/AngleBoardDiagram', () => ({ AngleBoardDiagram: () => null }));
vi.mock('../../play-drawer/AngleSlider', () => ({ AngleSlider: () => null }));
vi.mock('../../../lib/boards/use-set-board-angle', () => ({ useSetBoardAngle: () => vi.fn() }));
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, fireEvent } from '@testing-library/react';
import { createElement, type ReactElement, type ReactNode } from 'react';
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

type BarSide = { nativeItems?: number; titleItems?: number; customSlots?: number };
type ItemSides = { leading: BarSide; trailing: BarSide };

type BarItemStandIn = {
  type: string;
  label?: string;
  onPress?: () => void;
  visibilityPriority?: string;
  icon?: { type: string; name?: string };
};

const ctrl = vi.hoisted(() => ({
  board: null as BoardFields | null,
  bluetooth: null as BluetoothCtx,
  setActiveBoard: vi.fn(),
  variant: 'liquidGlass' as 'liquidGlass' | 'material',
  nativeHeader: false,
  nativeBarItems: false,
  onRail: false,
  // The navigation stack's frame: the window on a phone, the content beside the sidebar on iPad.
  frameWidth: 402,
  windowWidth: 402,
  isPad: false,
  widthClass: 'compact' as 'compact' | 'regular',
  anglePickerOpenChange: null as ((open: boolean) => void) | null,
  climbListAngleRow: null as { label: string } | null,
  openBoardControls: vi.fn(),
  nativeLeftItems: null as BarItemStandIn[] | null,
  nativeRightItems: null as BarItemStandIn[] | null,
  // The scroll-edge store the native header was handed.
  nativeScrollEdge: undefined as unknown,
  nativeCenterActionWidths: undefined as { leading: number; trailing: number } | undefined,
  nativeCenterItemSides: undefined as ItemSides | undefined,
  nativeLeftActions: undefined as ReactNode,
}));
const haptics = vi.hoisted(() => ({ light: vi.fn() }));

type ViewMockProps = {
  children?: ReactNode;
  onLayout?: (event: { nativeEvent: { layout: { height: number } } }) => void;
};
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
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
  useWindowDimensions: () => ({ width: ctrl.windowWidth, height: 874 }),
}));
vi.mock('expo-router/react-navigation', () => ({
  useFrameSize: (selector: (frame: { width: number; height: number }) => number) =>
    selector({ width: ctrl.frameWidth, height: 874 }),
}));

vi.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-gradient': 'true' }, children),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@boardsesh/board-config', () => ({ formatBoardDisplayName: (boardType: string) => `Display:${boardType}` }));

// Material branch renders an M3 Appbar (via react-native-paper). Stub it so the
// jsdom suite doesn't pull in Paper's native runtime.
vi.mock('react-native-paper', () => ({
  Appbar: {
    Header: ({ children }: { children?: ReactNode }) =>
      createElement('div', { 'data-appbar-header': 'true' }, children),
    Content: ({ title }: { title?: ReactNode }) => createElement('span', { 'data-appbar-title': 'true' }, title),
    Action: ({
      icon,
      onPress,
      accessibilityLabel,
    }: {
      icon?: ReactNode | ((props: { color: string; size: number }) => ReactNode);
      onPress?: () => void;
      accessibilityLabel?: string;
    }) =>
      createElement(
        'button',
        { onClick: onPress, 'data-appbar-action': accessibilityLabel ?? '' },
        typeof icon === 'function' ? icon({ color: '#000', size: 24 }) : icon,
      ),
  },
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    variant: ctrl.variant,
    systemColors: {
      label: '#000',
      secondaryLabel: '#888',
      separator: '#ccc',
      elevatedSurface: '#fff',
      background: '#fff',
      secondaryBackground: '#fff',
    },
    brandColors: { warning: '#FF9500' },
  }),
}));
vi.mock('../../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: ctrl.board }),
  useSetActiveBoard: () => ctrl.setActiveBoard,
}));
vi.mock('../../../providers/bluetooth-provider', () => ({ useOptionalBluetoothContext: () => ctrl.bluetooth }));
vi.mock('../../../providers/ble-control-sheet-provider', () => ({
  useBleControlSheet: () => ({ open: ctrl.openBoardControls, close: vi.fn() }),
}));
// The shared lightbulb hook also reads board presence + session state. Inert
// defaults here so the bulb follows local BLE (boardId null → session fallback,
// which is false), keeping these tests focused on the chrome layout.
vi.mock('../../../providers/board-presence-provider', () => ({ useBoardPresenceControls: () => ({ boardId: null }) }));
vi.mock('../../../providers/queue-provider', () => ({
  useQueueSessionControls: () => ({ isSessionWallLit: false, sessionId: null }),
}));
vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../../../hooks/use-native-glass', () => ({ useNativeGlass: () => false }));
// ProgressiveBlur renders the iOS blur path under this mode (short-circuits the
// native a11y / glass-capability hooks it would otherwise pull in).
vi.mock('../../../hooks/use-effective-surface-mode', () => ({ useEffectiveSurfaceMode: () => 'blur' }));
vi.mock('../../../lib/haptics', () => ({ hapticLight: haptics.light }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 4: 16 }, shadows: { sm: {} } }));
vi.mock('../../../theme/layout', () => ({
  glassSize: { standard: 48, capsule: 44, inline: 44, bar: 38 },
  TOOLBAR_SIDE_MARGIN: 16,
}));

vi.mock('../../GlassSurface', () => ({ GlassSurface: () => createElement('div', { 'data-glass': 'true' }) }));

type PressMockProps = {
  children?: ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  accessibilityLabel?: string;
};
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({ children, onPress, onLongPress, accessibilityLabel }: PressMockProps) =>
    createElement(
      'button',
      {
        onClick: onPress,
        // A long press, as far as jsdom can say one.
        onContextMenu: onLongPress,
        'data-pressable': accessibilityLabel ?? '',
        'data-capsule': accessibilityLabel?.includes('•') ? accessibilityLabel : '',
      },
      children,
    ),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({
  Icon: ({ name, color, size }: { name: string; color?: unknown; size?: number }) =>
    createElement('span', {
      'data-icon': name,
      'data-color': typeof color === 'string' ? color : '',
      'data-size': size,
    }),
}));
vi.mock('../../play-drawer/AngleSelectorSheet', () => ({
  AngleSelectorSheet: ({ visible }: { visible: boolean }) =>
    visible ? createElement('div', { 'data-angle-selector': 'true' }) : null,
}));
vi.mock('../../user-drawer/UserAvatarToolbarAction', () => ({
  UserAvatarToolbarAction: ({ variant }: { variant: 'glass' | 'material' }) =>
    createElement('button', { 'data-pressable': 'ariaLabels.userMenu', 'data-avatar-variant': variant }),
}));
// The onboarding reveal badge pulls in reanimated/paper through BoardToolbarAction;
// stub it so this layout suite stays free of the native animation runtime.
vi.mock('../../Badge', () => ({ Badge: () => createElement('span', { 'data-badge-dot': 'true' }) }));

import { CollapsingTopChrome } from '../CollapsingTopChrome';
import { createScrollEdgeBackdrop } from '../../../hooks/use-scroll-edge-backdrop';

function makeProps(over: Partial<Parameters<typeof CollapsingTopChrome>[0]> = {}) {
  return {
    canCreate: false,
    onCreate: vi.fn(),
    createAccessibilityLabel: 'create.label',
    onOpenBoardSwitcher: vi.fn(),
    onHeightChange: vi.fn(),
    ...over,
  };
}

const createAction = (root: HTMLElement) =>
  root.querySelector('[data-pressable="create.label"]') as HTMLButtonElement | null;
const lightbulb = (root: HTMLElement) =>
  (root.querySelector('[data-pressable="ble.connectBoard"]') ??
    root.querySelector('[data-pressable="lightControl.disconnect"]')) as HTMLButtonElement | null;
// The board control is the right-toolbar glyph whose VoiceOver label is the full
// board label (e.g. "Display:kilter • M • 40°"), so the '•' marker finds it.
const boardAction = (root: HTMLElement) =>
  root.querySelector('[data-capsule]:not([data-capsule=""])') as HTMLButtonElement | null;

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
  it('passes disclosed controls together with the reserved native controls', () => {
    ctrl.nativeHeader = true;
    const { container } = render(
      <CollapsingTopChrome {...makeProps()}>
        <span>Persistent filters</span>
        <button>Grade row</button>
      </CollapsingTopChrome>,
    );
    expect(container.querySelector('[data-native-controls]')?.textContent).toBe('Persistent filtersGrade row');
  });

  it('reserves the actual native action widths as controls are added or removed', () => {
    ctrl.nativeHeader = true;
    const { rerender } = render(<CollapsingTopChrome {...makeProps()} />);
    expect(ctrl.nativeCenterActionWidths).toEqual({ leading: 38, trailing: 0 });
    ctrl.board = board;
    rerender(<CollapsingTopChrome {...makeProps({ canCreate: true })} />);
    // UIKit's 38pt bar slots: avatar + create, then angle + board.
    expect(ctrl.nativeCenterActionWidths).toEqual({ leading: 76, trailing: 76 });
  });

  it.each([
    [true, '21'],
    [false, '24'],
  ])('scales the create glyph to the slot (native header: %s)', (nativeHeader, glyphSize) => {
    ctrl.nativeHeader = nativeHeader;
    const { container } = render(<CollapsingTopChrome {...makeProps({ canCreate: true })} />);
    // The native header's leading group is handed to UIKit, not rendered in place.
    const leading = nativeHeader ? render(<>{ctrl.nativeLeftActions}</>).container : container;
    expect(leading.querySelector('[data-icon="plus"]')?.getAttribute('data-size')).toBe(glyphSize);
  });

  it('speaks the current angle on the Material app-bar angle action too', () => {
    ctrl.variant = 'material';
    ctrl.board = board;
    const { container } = render(<CollapsingTopChrome {...makeProps()} />);
    expect(container.querySelector('[data-appbar-action="mobile.angleSelector.buttonAria"]')?.textContent).toBe('40°');
    expect(container.querySelector('[data-appbar-action="mobile.angleSelector.title"]')).toBeNull();
  });

  it('speaks the current angle on the default angle button', () => {
    ctrl.board = board;
    const { container } = render(<CollapsingTopChrome {...makeProps()} />);
    const angle = container.querySelector('[data-pressable="mobile.angleSelector.buttonAria"]');
    expect(angle?.textContent).toBe('40°');
  });

  it('sizes custom board controls instead of reserving the default angle and board pair', () => {
    ctrl.nativeHeader = true;
    ctrl.board = board;
    render(
      <CollapsingTopChrome
        {...makeProps({ boardControls: { content: <button>List options</button>, actionCount: 1 } })}
      />,
    );
    expect(ctrl.nativeCenterActionWidths).toEqual({ leading: 38, trailing: 38 });
  });

  it('replaces the floating board and angle pair with the supplied controls', () => {
    ctrl.board = board;
    const { container, getByRole } = render(
      <CollapsingTopChrome
        {...makeProps({ boardControls: { content: <button>List options</button>, actionCount: 1 } })}
      />,
    );
    expect(getByRole('button', { name: 'List options' })).not.toBeNull();
    expect(boardAction(container)).toBeNull();
    expect(container.querySelector('[data-pressable="mobile.angleSelector.buttonAria"]')).toBeNull();
  });

  beforeEach(() => {
    ctrl.board = null;
    ctrl.bluetooth = null;
    ctrl.variant = 'liquidGlass';
    ctrl.nativeHeader = false;
    ctrl.nativeScrollEdge = undefined;
    ctrl.nativeCenterActionWidths = undefined;
    ctrl.nativeCenterItemSides = undefined;
    ctrl.nativeLeftActions = undefined;
    ctrl.nativeBarItems = false;
    ctrl.onRail = false;
    ctrl.nativeLeftItems = null;
    ctrl.nativeRightItems = null;
    ctrl.frameWidth = 402;
    ctrl.windowWidth = 402;
    ctrl.isPad = false;
    ctrl.widthClass = 'compact';
    ctrl.anglePickerOpenChange = null;
    ctrl.climbListAngleRow = null;
    ctrl.openBoardControls.mockClear();
    haptics.light.mockClear();
  });

  it('keeps the current climb in the native center and only search below it', () => {
    ctrl.nativeHeader = true;
    const onOpenClimb = vi.fn();
    const { container, getByRole } = render(
      <CollapsingTopChrome
        {...makeProps({
          centerContent: (
            <button aria-label="On the wall: Fugue state" onClick={onOpenClimb}>
              Fugue state
            </button>
          ),
        })}
      >
        <span>Search</span>
      </CollapsingTopChrome>,
    );

    const climbButton = getByRole('button', { name: 'On the wall: Fugue state' });
    expect(container.querySelector('[data-native-center]')?.contains(climbButton)).toBe(true);
    expect(container.querySelector('[data-native-controls]')?.textContent).toBe('Search');
    expect(container.querySelectorAll('button')).toHaveLength(1);
    fireEvent.click(climbButton);
    expect(onOpenClimb).toHaveBeenCalledOnce();
  });

  it("hands the native header the screen's scroll-edge store, untouched", () => {
    ctrl.nativeHeader = true;
    const scrollEdge = createScrollEdgeBackdrop();
    const { rerender } = render(
      <CollapsingTopChrome {...makeProps({ scrollEdge })}>
        <span>Filter chips</span>
      </CollapsingTopChrome>,
    );
    expect(ctrl.nativeScrollEdge).toBe(scrollEdge);

    rerender(
      <CollapsingTopChrome {...makeProps()}>
        <span>Filter chips</span>
      </CollapsingTopChrome>,
    );
    expect(ctrl.nativeScrollEdge).toBeUndefined();
  });

  it('renders the board glyph for the active board, labelled with the board', () => {
    ctrl.board = board;
    const { container } = render(<CollapsingTopChrome {...makeProps()} />);
    expect(boardAction(container)?.getAttribute('data-capsule')).toBe('Display:kilter • M • 40°');
    // It's a glyph (the boards icon), not the old centred text pill.
    expect(boardAction(container)?.querySelector('[data-icon="boards"]')).not.toBeNull();
  });

  it('renders no board glyph when there is no active board', () => {
    const { container } = render(<CollapsingTopChrome {...makeProps()} />);
    expect(boardAction(container)).toBeNull();
  });

  it('opens the board switcher when the board glyph is pressed', () => {
    ctrl.board = board;
    const onOpenBoardSwitcher = vi.fn();
    const { container } = render(<CollapsingTopChrome {...makeProps({ onOpenBoardSwitcher })} />);
    fireEvent.click(boardAction(container)!);
    expect(onOpenBoardSwitcher).toHaveBeenCalledTimes(1);
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

  describe('Material variant', () => {
    beforeEach(() => {
      ctrl.variant = 'material';
    });

    it('renders an M3 app bar (avatar + board switcher) instead of the floating glass islands', () => {
      ctrl.board = board;
      const { container } = render(<CollapsingTopChrome {...makeProps()} />);
      // The M3 small app bar replaces the floating glass islands.
      expect(container.querySelector('[data-appbar-header]')).not.toBeNull();
      expect(container.querySelector('[data-avatar-variant="material"]')).not.toBeNull();
      // The board switcher carries the board label (a `•`-bearing PressableSurface).
      expect(boardAction(container)).not.toBeNull();
      // No floating GlassSurface island on Material.
      expect(container.querySelector('[data-glass]')).toBeNull();
    });

    it('reports the app bar height through onHeightChange', () => {
      const onHeightChange = vi.fn();
      const { container } = render(<CollapsingTopChrome {...makeProps({ onHeightChange })} />);
      fireEvent.click(container.querySelector('[data-has-layout="true"]') as HTMLElement);
      expect(onHeightChange).toHaveBeenCalledWith(64);
    });
  });

  describe('native bar items (iOS 26 iPhone and iPad)', () => {
    beforeEach(() => {
      ctrl.nativeHeader = true;
      ctrl.nativeBarItems = true;
    });

    const labels = (items: BarItemStandIn[] | null) => items?.map((item) => item.label ?? item.type) ?? null;
    const connected = () => ({
      isConnected: true,
      connect: vi.fn(),
      disconnect: vi.fn(),
      armUndoWallChangeToast: vi.fn(),
    });
    const climbList = { onOpenHistory: vi.fn(), badge: false };

    describe('in a horizontal bar', () => {
      it('keeps the glass avatar and + as the left island, and native items on the right', () => {
        ctrl.board = board;
        ctrl.bluetooth = connected();
        const { container } = render(<CollapsingTopChrome {...makeProps({ canCreate: true })} />);
        expect(ctrl.nativeLeftItems).toBeNull();
        const leading = render(<>{ctrl.nativeLeftActions}</>).container;
        expect(leading.querySelector('[data-pressable="ariaLabels.userMenu"]')).not.toBeNull();
        expect(createAction(leading)).not.toBeNull();
        expect(labels(ctrl.nativeRightItems)).toEqual(['40°', 'board', 'custom']);
        // The angle picker sheet still mounts beside the header.
        expect(container.querySelector('[data-native-angle-picker]')).not.toBeNull();
        expect(ctrl.nativeCenterItemSides).toEqual({
          leading: { customSlots: 2 },
          trailing: { nativeItems: 3, titleItems: 1 },
        });
      });

      it('keeps the glass bulb last, and its long press opens Board controls', () => {
        ctrl.board = board;
        ctrl.bluetooth = connected();
        render(<CollapsingTopChrome {...makeProps()} />);
        const bulb = ctrl.nativeRightItems?.at(-1) as BarItemStandIn & { element?: ReactElement };
        expect(bulb.type).toBe('custom');
        const { container } = render(bulb.element as ReactElement);
        const bulbButton = container.querySelector('[data-pressable="lightControl.disconnect"]') as HTMLElement;
        fireEvent.contextMenu(bulbButton);
        expect(ctrl.openBoardControls).toHaveBeenCalledWith(expect.objectContaining({ surface: 'toolbar' }));
      });

      it.each([
        [375, true],
        [402, true],
        [440, false],
      ])('on a %ipt iPhone beside the wall capsule, moves the angle into the list menu: %s', (width, moved) => {
        ctrl.frameWidth = width;
        ctrl.board = board;
        render(
          <CollapsingTopChrome
            {...makeProps({ canCreate: true, hideLight: true, climbListBarActions: climbList })}
            centerContent={<button>On the wall</button>}
          />,
        );
        expect(labels(ctrl.nativeRightItems)).toEqual(
          moved ? ['history', 'list-menu'] : ['40°', 'history', 'list-menu'],
        );
        expect(ctrl.climbListAngleRow).toEqual(moved ? expect.objectContaining({ label: 'Board angle, 40°' }) : null);
      });

      it('keeps the angle in the bar when no capsule needs the room', () => {
        ctrl.frameWidth = 375;
        ctrl.board = board;
        render(
          <CollapsingTopChrome {...makeProps({ canCreate: true, hideLight: true, climbListBarActions: climbList })} />,
        );
        expect(labels(ctrl.nativeRightItems)).toEqual(['40°', 'history', 'list-menu']);
        expect(ctrl.climbListAngleRow).toBeNull();
      });

      it('anchors the showcase callout on the native history item, second from the end', () => {
        ctrl.board = board;
        const { container } = render(
          <CollapsingTopChrome
            {...makeProps({ hideLight: true, climbListBarActions: climbList, anchorBoardButton: true })}
          />,
        );
        const anchor = container.querySelector('[data-native-anchor="board-history-button"]');
        expect(anchor?.getAttribute('data-position-from-end')).toBe('1');
      });
    });

    describe('on a compact-width iPad (Split View under 700pt)', () => {
      beforeEach(() => {
        ctrl.isPad = true;
        ctrl.widthClass = 'compact';
      });

      it('uses the native "40°" item and its sheet, as on iPhone', () => {
        ctrl.board = board;
        ctrl.frameWidth = 507;
        ctrl.windowWidth = 507;
        const { container } = render(
          <CollapsingTopChrome {...makeProps({ canCreate: true, hideLight: true, climbListBarActions: climbList })} />,
        );
        expect(labels(ctrl.nativeRightItems)).toEqual(['40°', 'history', 'list-menu']);
        expect(container.querySelector('[data-native-angle-picker]')).not.toBeNull();
      });

      it("moves the angle into the list menu when the stack's frame, not the window, is short of room", () => {
        ctrl.board = board;
        // A wide window would leave the capsule room; the narrow frame is what the bar gets.
        ctrl.windowWidth = 1210;
        ctrl.frameWidth = 375;
        render(
          <CollapsingTopChrome
            {...makeProps({ canCreate: true, hideLight: true, climbListBarActions: climbList })}
            centerContent={<button>On the wall</button>}
          />,
        );
        expect(labels(ctrl.nativeRightItems)).toEqual(['history', 'list-menu']);
        expect(ctrl.climbListAngleRow).toEqual(expect.objectContaining({ label: 'Board angle, 40°' }));
      });
    });

    describe('on a regular-width iPad', () => {
      beforeEach(() => {
        ctrl.isPad = true;
        ctrl.widthClass = 'regular';
        // iPad Pro 11" landscape: a 1210pt window, 930pt of it the content column beside the sidebar.
        ctrl.windowWidth = 1210;
        ctrl.frameWidth = 930;
      });

      it("keeps an open picker's trigger through a width-class flip until the picker closes itself", () => {
        ctrl.board = board;
        const props = makeProps({ hideLight: true, climbListBarActions: climbList });
        const { rerender } = render(<CollapsingTopChrome {...props} />);
        expect(labels(ctrl.nativeRightItems)).toEqual(['custom', 'history', 'list-menu']);
        act(() => ctrl.anglePickerOpenChange?.(true));
        // Split View narrows to compact while the popover is up: the glass angle stays mounted.
        ctrl.widthClass = 'compact';
        rerender(<CollapsingTopChrome {...props} />);
        expect(labels(ctrl.nativeRightItems)).toEqual(['custom', 'history', 'list-menu']);
        // The picker sees the new width and closes; only then does the native item take over.
        act(() => ctrl.anglePickerOpenChange?.(false));
        expect(labels(ctrl.nativeRightItems)).toEqual(['40°', 'history', 'list-menu']);
      });

      it('keeps the glass "40°" first in the trailing group, so its popover has a view to point at', () => {
        ctrl.board = board;
        const { container } = render(
          <CollapsingTopChrome {...makeProps({ canCreate: true, hideLight: true, climbListBarActions: climbList })} />,
        );
        expect(labels(ctrl.nativeRightItems)).toEqual(['custom', 'history', 'list-menu']);
        const angle = ctrl.nativeRightItems?.[0] as BarItemStandIn & { element?: ReactElement };
        const angleButton = render(angle.element as ReactElement).container.querySelector(
          '[data-pressable="mobile.angleSelector.buttonAria"]',
        );
        expect(angleButton).not.toBeNull();
        // No second, unanchored picker beside the header.
        expect(container.querySelector('[data-native-angle-picker]')).toBeNull();
        expect(ctrl.nativeCenterItemSides?.trailing).toEqual({ nativeItems: 3, titleItems: 0 });
      });

      it('never moves the angle into the list menu, which could not anchor its popover', () => {
        ctrl.board = board;
        ctrl.frameWidth = 375;
        render(
          <CollapsingTopChrome
            {...makeProps({ canCreate: true, hideLight: true, climbListBarActions: climbList })}
            centerContent={<button>On the wall</button>}
          />,
        );
        expect(labels(ctrl.nativeRightItems)).toEqual(['custom', 'history', 'list-menu']);
        expect(ctrl.climbListAngleRow).toBeNull();
      });

      it('keeps the board switcher native and the glass bulb last on Discover', () => {
        ctrl.board = board;
        ctrl.bluetooth = connected();
        render(<CollapsingTopChrome {...makeProps({ canCreate: true })} />);
        expect(labels(ctrl.nativeRightItems)).toEqual(['custom', 'board', 'custom']);
      });

      it('uses native items alone for a fixed-angle board', () => {
        ctrl.board = { ...board, isAngleAdjustable: false };
        render(<CollapsingTopChrome {...makeProps({ hideLight: true, climbListBarActions: climbList })} />);
        expect(labels(ctrl.nativeRightItems)).toEqual(['history', 'list-menu']);
      });
    });

    describe('on the iPhone Duo rail', () => {
      beforeEach(() => {
        ctrl.onRail = true;
      });

      it('hands UIKit every action as a native item, the bulb included', () => {
        ctrl.board = board;
        ctrl.bluetooth = connected();
        render(<CollapsingTopChrome {...makeProps({ canCreate: true })} />);
        expect(labels(ctrl.nativeLeftItems)).toEqual(['account', 'create.label']);
        expect(labels(ctrl.nativeRightItems)).toEqual(['40°', 'board', 'lightbulb']);
        // Every item has left the bar, so the capsule has the whole bar.
        expect(ctrl.nativeCenterItemSides).toEqual({ leading: {}, trailing: {} });
      });

      it('gives + an SF Symbol, its label and the highest visibility priority, and fires onCreate', () => {
        const onCreate = vi.fn();
        render(<CollapsingTopChrome {...makeProps({ canCreate: true, onCreate })} />);
        const create = ctrl.nativeLeftItems?.[1];
        expect(create).toMatchObject({
          type: 'button',
          label: 'create.label',
          icon: { type: 'sfSymbol', name: 'plus' },
          visibilityPriority: 'high',
        });
        create?.onPress?.();
        expect(onCreate).toHaveBeenCalledTimes(1);
      });

      it('leaves out + without canCreate and the bulb when hideLight is set', () => {
        ctrl.bluetooth = connected();
        render(<CollapsingTopChrome {...makeProps({ hideLight: true })} />);
        expect(labels(ctrl.nativeLeftItems)).toEqual(['account']);
        expect(ctrl.nativeRightItems).toBeNull();
      });

      it('keeps the angle on the rail beside the capsule, and logs no history anchor', () => {
        ctrl.frameWidth = 375;
        ctrl.board = board;
        const { container } = render(
          <CollapsingTopChrome
            {...makeProps({ hideLight: true, climbListBarActions: climbList, anchorBoardButton: true })}
            centerContent={<button>On the wall</button>}
          />,
        );
        expect(labels(ctrl.nativeRightItems)).toEqual(['40°', 'history', 'list-menu']);
        expect(container.querySelector('[data-native-anchor]')).toBeNull();
      });
    });

    it('keeps an interactive centre capsule as a custom view', () => {
      const { getByRole } = render(
        <CollapsingTopChrome {...makeProps({ centerContent: <button>On the wall</button> })} />,
      );
      expect(getByRole('button', { name: 'On the wall' })).toBeTruthy();
    });
  });
});
