// @vitest-environment jsdom
vi.mock('../../AccessibleTextInput', async () => {
  const { TextInput } = await import('react-native');
  return { AccessibleTextInput: TextInput };
});
vi.mock('../../../hooks/use-bold-text', () => ({ useBoldText: () => false }));
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const spies = vi.hoisted(() => ({
  openControls: vi.fn(),
  lightbulbPress: vi.fn(),
  lightbulbLongPress: vi.fn(),
  lightbulbOptions: null as unknown,
  localConnected: true,
  pressAction: 'disconnect' as string,
  currentClimb: null as null | { uuid: string; name: string; difficulty: string },
  byline: 'V7 · 1.4k sends' as string | null,
  announce: vi.fn(),
  reduceMotion: false,
  nativeGlass: true,
  enterAnimation: vi.fn(() => ({})),
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (options: { ios?: unknown }) => options.ios },
  PlatformColor: (name: string) => name,
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
  View: ({
    children,
    style,
    accessibilityElementsHidden,
    importantForAccessibility,
  }: {
    children?: ReactNode;
    style?: unknown;
    accessibilityElementsHidden?: boolean;
    importantForAccessibility?: string;
  }) =>
    createElement(
      'div',
      {
        'data-style': JSON.stringify(Object.assign({}, ...[style].flat(10).filter(Boolean))),
        'data-a11y-hidden': accessibilityElementsHidden,
        'data-important-for-a11y': importantForAccessibility,
      },
      children,
    ),
  Pressable: ({
    children,
    onPress,
    accessibilityRole,
    accessibilityLabel,
    accessibilityHint,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityRole?: string;
    accessibilityLabel?: string;
    accessibilityHint?: string;
  }) =>
    createElement(
      'button',
      {
        'data-pressable': 'true',
        'data-role': accessibilityRole,
        'data-label': accessibilityLabel,
        'data-hint': accessibilityHint,
        onClick: onPress,
      },
      children,
    ),
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: (styles: Record<string, unknown>) => styles,
    absoluteFill: {},
    hairlineWidth: 1,
  },
  AccessibilityInfo: { announceForAccessibility: spies.announce },
}));

vi.mock('react-native-reanimated', () => ({
  default: {
    View: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-animated': 'true' }, children),
  },
  FadeIn: { duration: spies.enterAnimation },
  useReducedMotion: () => spies.reduceMotion,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => (params ? `${key} ${JSON.stringify(params)}` : key),
  }),
}));
vi.mock('../../../hooks/use-native-glass', () => ({ useNativeGlass: () => spies.nativeGlass }));
vi.mock('../../../providers/ble-control-sheet-provider', () => ({
  useBleControlSheet: () => ({ open: spies.openControls, close: vi.fn() }),
}));
const WARNING = '#FBBF24';
const PRIMARY = '#6D28D9';
vi.mock('../../../providers/theme-provider', () => ({
  useOptionalTheme: () => null,
  useTheme: () => ({
    systemColors: { label: '#111111', secondaryBackground: '#222222', background: '#000000' },
    brandColors: { warning: '#FBBF24', primary: '#6D28D9' },
  }),
}));
vi.mock('../../../lib/haptics', () => ({ hapticLight: vi.fn(), hapticMedium: vi.fn() }));
vi.mock('../../ble/use-lightbulb-control', () => ({
  useLightbulbControl: (options: unknown) => {
    spies.lightbulbOptions = options;
    return {
      onPress: spies.lightbulbPress,
      onLongPress: spies.lightbulbLongPress,
      localConnected: spies.localConnected,
      pressAction: spies.pressAction,
    };
  },
}));
vi.mock('../../../providers/queue/queue-contexts', () => ({
  useQueueData: () => ({
    queue: [],
    currentClimbQueueItem: spies.currentClimb ? { uuid: 'item-1', climb: spies.currentClimb } : null,
  }),
}));
vi.mock('../../chrome/use-settled-header-value', () => ({ useSettledHeaderValue: <T,>(value: T) => value }));
vi.mock('../../../providers/drawer-host-provider', () => ({ useDrawerHost: () => ({ boardConfig: null }) }));
vi.mock('../../../hooks/use-display-grade', () => ({
  useDisplayGrade: () => ({ resolveGrade: (climb: { difficulty: string }) => ({ label: climb.difficulty }) }),
}));
vi.mock('../../../lib/graphql/hooks', () => ({
  useProfile: () => ({ data: { avatarUrl: 'https://example.com/me.png', displayName: 'Marco', email: null } }),
}));
vi.mock('../use-climb-byline', () => ({ useClimbByline: () => spies.byline }));
vi.mock('../../Avatar', () => ({
  Avatar: ({ uri, name, size }: { uri?: string | null; name?: string | null; size?: number }) =>
    createElement('img', { 'data-avatar': 'true', 'data-uri': uri, 'data-name': name, 'data-size': size }),
}));
vi.mock('../../Text', () => ({
  Text: ({
    children,
    style,
    numberOfLines,
    ellipsizeMode,
    variant,
  }: {
    children?: ReactNode;
    style?: unknown;
    numberOfLines?: number;
    ellipsizeMode?: string;
    variant?: string;
  }) =>
    createElement(
      'span',
      {
        'data-text': 'true',
        'data-variant': variant,
        'data-style': JSON.stringify(Object.assign({}, ...[style].flat(10).filter(Boolean))),
        'data-lines': numberOfLines,
        'data-ellipsize': ellipsizeMode,
      },
      children,
    ),
}));
vi.mock('../../LargeContentViewer', () => ({
  LargeContentViewer: ({
    children,
    style,
    onActivate,
  }: {
    children?: ReactNode;
    style?: unknown;
    onActivate?: () => void;
  }) =>
    createElement(
      'div',
      {
        'data-label-viewer': 'true',
        'data-style': JSON.stringify(Object.assign({}, ...[style].flat(10).filter(Boolean))),
        // Stands in for the finger lifting while the viewer is up.
        onDoubleClick: onActivate,
      },
      children,
    ),
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    onLongPress,
    accessibilityActions,
    feedback,
    accessibilityRole,
    accessibilityLabel,
    accessibilityHint,
    style,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    onLongPress?: () => void;
    accessibilityActions?: { name: string; label: string }[];
    feedback?: string;
    accessibilityRole?: string;
    accessibilityLabel?: string;
    accessibilityHint?: string;
    style?: unknown;
  }) =>
    createElement(
      'button',
      {
        'data-pressable': 'true',
        'data-pressable-surface': 'true',
        'data-feedback': feedback,
        'data-role': accessibilityRole,
        'data-label': accessibilityLabel,
        'data-hint': accessibilityHint,
        'data-actions': accessibilityActions ? JSON.stringify(accessibilityActions) : undefined,
        'data-style': JSON.stringify(Object.assign({}, ...[style].flat(10).filter(Boolean))),
        onClick: onPress,
        // Stands in for a long-press in jsdom.
        onContextMenu: onLongPress,
      },
      children,
    ),
}));
vi.mock('../../Icon', () => ({
  Icon: ({ name, color }: { name: string; color?: string }) =>
    createElement('i', { 'data-icon': name, 'data-icon-color': String(color) }),
}));
vi.mock('../../GlassSurface', () => ({
  GlassSurface: ({
    children,
    style,
    borderRadius,
    glassEffectStyle,
    tintColor,
  }: {
    children?: ReactNode;
    style?: unknown;
    borderRadius?: number;
    glassEffectStyle?: string;
    tintColor?: string;
  }) =>
    createElement(
      'div',
      {
        'data-glass-surface': 'true',
        'data-style': JSON.stringify(Object.assign({}, ...[style].flat(10).filter(Boolean))),
        'data-glass-radius': borderRadius,
        'data-glass-style': glassEffectStyle,
        'data-glass-tint': tintColor,
      },
      children,
    ),
}));

import { BoardHeldCapsule } from '../BoardHeldCapsule';
describe('BoardHeldCapsule', () => {
  beforeEach(() => {
    spies.openControls.mockClear();
    spies.lightbulbPress.mockClear();
    spies.lightbulbLongPress.mockClear();
    spies.nativeGlass = true;
    spies.localConnected = true;
    spies.pressAction = 'disconnect';
    spies.currentClimb = null;
    spies.byline = 'V7 · 1.4k sends';
  });

  describe('with no current climb', () => {
    it('says "You have the board" with a lit bulb in the amber glass tint', () => {
      const { container } = render(<BoardHeldCapsule ledless={false} />);
      expect(container.textContent).toContain('ble.barControl.youHaveBoard');
      expect(container.querySelector('[data-icon="lightbulb.fill"]')?.getAttribute('data-icon-color')).toBe(WARNING);
      expect(container.querySelector('[data-glass-surface]')?.getAttribute('data-glass-tint')).toBe(
        'rgba(251, 191, 36, 0.14)',
      );
    });

    it('on a board with no lights, pins in the brand tone and never claims lit LEDs', () => {
      const { container } = render(<BoardHeldCapsule ledless />);
      expect(container.textContent).toContain('ble.barControl.wallHeldLabel');
      expect(container.querySelector('[data-icon="lightbulb.fill"]')).toBeNull();
      expect(container.querySelector('[data-icon="pin.fill"]')?.getAttribute('data-icon-color')).toBe(PRIMARY);
      expect(container.querySelector('[data-glass-surface]')?.getAttribute('data-glass-tint')).toBe(
        'rgba(109, 40, 217, 0.14)',
      );
    });
  });

  describe('with a current climb', () => {
    beforeEach(() => {
      spies.currentClimb = { uuid: 'climb-1', name: 'Kish Mud Prison', difficulty: 'V7' };
    });

    it('shows your face, then the climb over its grade · sends byline', () => {
      const { container } = render(<BoardHeldCapsule ledless={false} />);
      const avatar = container.querySelector('[data-avatar]');
      expect(avatar?.getAttribute('data-uri')).toBe('https://example.com/me.png');
      expect(avatar?.getAttribute('data-name')).toBe('Marco');
      const lines = [...container.querySelectorAll('[data-text]')].map((node) => node.textContent);
      expect(lines).toEqual(['Kish Mud Prison', 'V7 · 1.4k sends']);
      expect(container.querySelector('[data-icon="lightbulb.fill"]')).toBeNull();
      // Still the amber "LEDs on" tone.
      expect(container.querySelector('[data-glass-surface]')?.getAttribute('data-glass-tint')).toBe(
        'rgba(251, 191, 36, 0.14)',
      );
    });

    it('drops the byline line when there is nothing to say', () => {
      spies.byline = null;
      const { container } = render(<BoardHeldCapsule ledless={false} />);
      const lines = [...container.querySelectorAll('[data-text]')].map((node) => node.textContent);
      expect(lines).toEqual(['Kish Mud Prison']);
    });

    it('names the climb and the hold in one spoken label', () => {
      const { container } = render(<BoardHeldCapsule ledless={false} />);
      const button = container.querySelector('[data-pressable="true"]') as HTMLElement;
      expect(button.getAttribute('data-label')).toBe(
        'ble.barControl.youHaveBoardWithClimb {"name":"Kish Mud Prison","grade":"V7"}',
      );
      expect(button.getAttribute('data-hint')).toBe('ble.barControl.connectedHint');
    });

    it('says "You have the wall" on a board with no lights', () => {
      const { container } = render(<BoardHeldCapsule ledless />);
      const button = container.querySelector('[data-pressable="true"]') as HTMLElement;
      expect(button.getAttribute('data-label')).toBe(
        'ble.barControl.wallHeldWithClimb {"name":"Kish Mud Prison","grade":"V7"}',
      );
      expect(button.getAttribute('data-hint')).toBe('ble.barControl.wallHeldHint');
    });
  });

  describe.each([
    ['with no current climb', null],
    ['with a current climb', { uuid: 'climb-1', name: 'Kish Mud Prison', difficulty: 'V7' }],
  ])('press handling %s', (_label, climb) => {
    beforeEach(() => {
      spies.currentClimb = climb;
    });

    it("lets go of the board on a tap, through the lightbulbs' press path", () => {
      const { container } = render(<BoardHeldCapsule ledless={false} />);
      expect(spies.lightbulbOptions).toEqual({ surface: 'header_pill', onOpenControls: spies.openControls });
      fireEvent.click(container.querySelector('[data-pressable="true"]') as HTMLElement);
      expect(spies.lightbulbPress).toHaveBeenCalledTimes(1);
      expect(spies.lightbulbLongPress).not.toHaveBeenCalled();
    });

    it('stays a button on a wall with no lights, so a tap releases it', () => {
      spies.localConnected = false;
      spies.pressAction = 'releaseWall';
      const { container } = render(<BoardHeldCapsule ledless />);
      const button = container.querySelector('[data-pressable="true"]') as HTMLElement;
      expect(button).not.toBeNull();
      fireEvent.click(button);
      expect(spies.lightbulbPress).toHaveBeenCalledTimes(1);
    });

    it.each(['connect', 'takeWall', 'relay', 'noop'])(
      'never forwards a tap that would %s: a settled pill can outlive the hold',
      (pressAction) => {
        spies.pressAction = pressAction;
        const { container } = render(<BoardHeldCapsule ledless={false} />);
        fireEvent.click(container.querySelector('[data-pressable="true"]') as HTMLElement);
        expect(spies.lightbulbPress).not.toHaveBeenCalled();
      },
    );

    it('opens the Bluetooth controls on a long-press while this phone holds the link', () => {
      const { container } = render(<BoardHeldCapsule ledless={false} />);
      const button = container.querySelector('[data-pressable="true"]') as HTMLElement;
      expect(JSON.parse(button.getAttribute('data-actions') ?? 'null')).toEqual([
        { name: 'longpress', label: 'ble.holdForControls' },
      ]);
      fireEvent.contextMenu(button);
      expect(spies.lightbulbLongPress).toHaveBeenCalledTimes(1);
      expect(spies.lightbulbPress).not.toHaveBeenCalled();
    });

    it('opens the controls, never lets go, when the Large Content Viewer takes the hold', () => {
      const { container } = render(<BoardHeldCapsule ledless={false} />);
      fireEvent.doubleClick(container.querySelector('[data-label-viewer]') as HTMLElement);
      expect(spies.lightbulbLongPress).toHaveBeenCalledTimes(1);
      expect(spies.lightbulbPress).not.toHaveBeenCalled();
    });

    it('ignores a long-press with no radio link, and offers no such action', () => {
      spies.localConnected = false;
      const { container } = render(<BoardHeldCapsule ledless />);
      const button = container.querySelector('[data-pressable="true"]') as HTMLElement;
      expect(button.getAttribute('data-actions')).toBeNull();
      fireEvent.contextMenu(button);
      expect(spies.lightbulbLongPress).not.toHaveBeenCalled();
    });
  });
});
