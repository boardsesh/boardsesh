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
  variant: 'liquidGlass' as 'liquidGlass' | 'material',
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
        onClick: onLayout ? () => onLayout({ nativeEvent: { layout: { height: 72 } } }) : undefined,
      },
      children,
    ),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, absoluteFill: {}, hairlineWidth: 1 },
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

// The Material branch (CollapsingTopChrome) renders an M3 Appbar via react-native-paper.
// Stub it so the jsdom suite doesn't pull in Paper's native runtime.
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
vi.mock('../../../theme/layout', () => ({ glassSize: { standard: 48, capsule: 44 } }));

vi.mock('../../GlassSurface', () => ({ GlassSurface: () => createElement('div', { 'data-glass': 'true' }) }));

type PressMockProps = { children?: ReactNode; onPress?: () => void; accessibilityLabel?: string };
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({ children, onPress, accessibilityLabel }: PressMockProps) =>
    createElement(
      'button',
      {
        onClick: onPress,
        'data-pressable': accessibilityLabel ?? '',
        'data-capsule': accessibilityLabel?.includes('•') ? accessibilityLabel : '',
      },
      children,
    ),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }) }));
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

import { DiscoverTopChrome } from '../DiscoverTopChrome';

function makeProps(over: Partial<Parameters<typeof DiscoverTopChrome>[0]> = {}) {
  return {
    canCreate: false,
    onCreate: vi.fn(),
    onOpenBoardSwitcher: vi.fn(),
    onHeightChange: vi.fn(),
    ...over,
  };
}

const createAction = (root: HTMLElement) =>
  root.querySelector('[data-pressable="library.createFab.ariaLabel"]') as HTMLButtonElement | null;
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

describe('DiscoverTopChrome', () => {
  beforeEach(() => {
    ctrl.board = null;
    ctrl.bluetooth = null;
    ctrl.variant = 'liquidGlass';
    haptics.light.mockClear();
  });

  it('renders the board glyph for the active board', () => {
    ctrl.board = board;
    const { container } = render(<DiscoverTopChrome {...makeProps()} />);
    expect(boardAction(container)?.getAttribute('data-capsule')).toBe('Display:kilter • M • 40°');
  });

  it('opens the board switcher when the board glyph is pressed', () => {
    ctrl.board = board;
    const onOpenBoardSwitcher = vi.fn();
    const { container } = render(<DiscoverTopChrome {...makeProps({ onOpenBoardSwitcher })} />);
    fireEvent.click(boardAction(container)!);
    expect(onOpenBoardSwitcher).toHaveBeenCalledTimes(1);
  });

  it('gates the create action on canCreate and fires onCreate', () => {
    ctrl.board = board;
    const onCreate = vi.fn();
    const { container, rerender } = render(<DiscoverTopChrome {...makeProps({ canCreate: false, onCreate })} />);
    expect(createAction(container)).toBeNull();
    rerender(<DiscoverTopChrome {...makeProps({ canCreate: true, onCreate })} />);
    fireEvent.click(createAction(container)!);
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('shows the lightbulb only when bluetooth is available and reflects its state', () => {
    ctrl.board = board;
    const { container, rerender } = render(<DiscoverTopChrome {...makeProps()} />);
    expect(lightbulb(container)).toBeNull();

    ctrl.bluetooth = {
      isConnected: true,
      connect: vi.fn(),
      disconnect: vi.fn().mockResolvedValue(undefined),
      armUndoWallChangeToast: vi.fn(),
    };
    rerender(<DiscoverTopChrome {...makeProps()} />);
    expect(lightbulb(container)).not.toBeNull();
    expect(container.querySelector('[data-icon="lightbulb.fill"]')).not.toBeNull();
  });

  it('reports its measured height through onHeightChange', () => {
    const onHeightChange = vi.fn();
    const { container } = render(<DiscoverTopChrome {...makeProps({ onHeightChange })} />);
    fireEvent.click(container.querySelector('[data-has-layout="true"]') as HTMLElement);
    expect(onHeightChange).toHaveBeenCalledWith(72);
  });

  describe('Material variant', () => {
    beforeEach(() => {
      ctrl.variant = 'material';
    });

    it('renders the M3 app bar (no floating glass island, no in-chrome create) on Android', () => {
      ctrl.board = board;
      const { container } = render(<DiscoverTopChrome {...makeProps({ canCreate: true })} />);
      expect(container.querySelector('[data-appbar-header]')).not.toBeNull();
      expect(container.querySelector('[data-avatar-variant="material"]')).not.toBeNull();
      expect(boardAction(container)).not.toBeNull();
      // No glass surface, and the create "+" is the screen-level FAB (DiscoverLibrary),
      // not an in-chrome island.
      expect(container.querySelector('[data-glass]')).toBeNull();
      expect(createAction(container)).toBeNull();
    });
  });
});
