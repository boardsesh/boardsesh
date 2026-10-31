// @vitest-environment jsdom
vi.mock('../../AccessibleTextInput', async () => {
  const { TextInput } = await import('react-native');
  return { AccessibleTextInput: TextInput };
});
vi.mock('../../../hooks/use-bold-text', () => ({ useBoldText: () => false }));
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { LayoutChangeEvent } from 'react-native';
import type { WallGlowInput, WallGlowLayer } from '../../play-drawer/use-wall-glow';

const spies = vi.hoisted(() => ({
  openControls: vi.fn(),
  lightbulbPress: vi.fn(),
  lightbulbLongPress: vi.fn(),
  lightbulbOptions: null as unknown,
  localConnected: true,
  pressAction: 'disconnect' as string,
  currentClimb: null as null | { uuid: string; name: string; difficulty: string; mirrored?: boolean },
  byline: 'V7 · 1.4k sends' as string | null,
  announce: vi.fn(),
  reduceMotion: false,
  nativeGlass: true,
  enterAnimation: vi.fn(() => ({})),
  colorScheme: 'dark' as 'dark' | 'light',
  glowInput: null as WallGlowInput | null,
  glowEnabled: null as boolean | null,
  glowCalls: 0,
  glowMirrored: false,
  layoutWidth: 210,
  layoutHeight: 38,
}));

vi.mock('../use-climb-wall-glow', () => ({
  useClimbWallGlow: (climb: { mirrored?: boolean }, _boardConfig: unknown, enabled: boolean) => {
    spies.glowEnabled = enabled;
    spies.glowCalls += 1;
    spies.glowMirrored = climb.mirrored === true;
    return enabled ? spies.glowInput : null;
  },
}));
vi.mock('../../play-drawer/WallGlow', () => ({
  WallGlow: ({ layer, width }: { layer: WallGlowLayer; width: number }) =>
    createElement('div', {
      'data-wall-glow': layer.key,
      'data-glow-width': width,
      'data-glow-surface': JSON.stringify(layer.surface),
      'data-glow-readable-zone': layer.readableZone,
    }),
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
    pointerEvents,
    onLayout,
  }: {
    children?: ReactNode;
    style?: unknown;
    accessibilityElementsHidden?: boolean;
    importantForAccessibility?: string;
    pointerEvents?: string;
    onLayout?: (event: LayoutChangeEvent) => void;
  }) =>
    createElement(
      'div',
      {
        'data-style': JSON.stringify(Object.assign({}, ...[style].flat(10).filter(Boolean))),
        'data-a11y-hidden': accessibilityElementsHidden,
        'data-important-for-a11y': importantForAccessibility,
        'data-pointer-events': pointerEvents,
        onDoubleClick: onLayout
          ? () =>
              onLayout({
                nativeEvent: { layout: { width: spies.layoutWidth, height: spies.layoutHeight } },
              } as LayoutChangeEvent)
          : undefined,
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
    View: ({
      children,
      style,
      onLayout,
    }: {
      children?: ReactNode;
      style?: unknown;
      onLayout?: (event: LayoutChangeEvent) => void;
    }) =>
      createElement(
        'div',
        {
          'data-animated': 'true',
          'data-style': JSON.stringify(Object.assign({}, ...[style].flat(10).filter(Boolean))),
          onDoubleClick: onLayout
            ? () =>
                onLayout({
                  nativeEvent: { layout: { width: spies.layoutWidth, height: spies.layoutHeight } },
                } as LayoutChangeEvent)
            : undefined,
        },
        children,
      ),
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
    colorScheme: spies.colorScheme,
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
    color,
  }: {
    children?: ReactNode;
    style?: unknown;
    numberOfLines?: number;
    ellipsizeMode?: string;
    variant?: string;
    color?: unknown;
  }) =>
    createElement(
      'span',
      {
        'data-text': 'true',
        'data-variant': variant,
        'data-color': String(color),
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

import { BoardHeldCapsule, HeldClimbCapsule } from '../BoardHeldCapsule';
import { NativeHeaderActionContext } from '../../chrome/native-header-action-context';
import { wallGlowSurfaces } from '../../../theme/colors';

const TEST_GLOW: WallGlowInput = {
  key: 'climb-1-holds',
  holds: [
    { x: 25, y: 10, color: '#FF00FF' },
    { x: 75, y: 30, color: '#4DF5FD' },
    { x: 40, y: 70, color: '#FFA500' },
    { x: 60, y: 130, color: '#00DD00' },
  ],
  boardWidth: 100,
  boardHeight: 150,
};

describe('BoardHeldCapsule', () => {
  beforeEach(() => {
    spies.openControls.mockClear();
    spies.lightbulbPress.mockClear();
    spies.lightbulbLongPress.mockClear();
    spies.enterAnimation.mockClear();
    spies.nativeGlass = true;
    spies.localConnected = true;
    spies.pressAction = 'disconnect';
    spies.currentClimb = null;
    spies.byline = 'V7 · 1.4k sends';
    spies.colorScheme = 'dark';
    spies.glowInput = null;
    spies.glowEnabled = null;
    spies.glowCalls = 0;
    spies.glowMirrored = false;
    spies.layoutWidth = 210;
    spies.layoutHeight = 38;
  });

  describe('with no current climb', () => {
    it('says "You have the board" with a lit bulb in the amber glass tint', () => {
      const { container } = render(<BoardHeldCapsule ledless={false} />);
      expect(container.textContent).toContain('ble.barControl.youHaveBoard');
      expect(container.querySelector('[data-icon="lightbulb.fill"]')?.getAttribute('data-icon-color')).toBe(WARNING);
      expect(container.querySelector('[data-glass-surface]')?.getAttribute('data-glass-tint')).toBe(
        'rgba(251, 191, 36, 0.14)',
      );
      expect(spies.glowCalls).toBe(0);
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

    it.each(['dark', 'light'] as const)(
      'uses the wall button’s actual glow layer and readable labels in %s',
      (scheme) => {
        spies.glowInput = TEST_GLOW;
        spies.colorScheme = scheme;
        const { container } = render(
          <NativeHeaderActionContext.Provider value={true}>
            <BoardHeldCapsule ledless={false} />
          </NativeHeaderActionContext.Provider>,
        );
        const nativeTitle = container.firstElementChild as HTMLElement;
        // Before the native title is measured, the existing amber remains.
        expect(container.querySelector('[data-glass-surface]')).not.toBeNull();
        expect(container.querySelector('[data-wall-glow]')).toBeNull();
        fireEvent.doubleClick(nativeTitle);
        expect(container.firstElementChild).toBe(nativeTitle);
        expect(container.querySelector('[data-glass-surface]')).toBeNull();
        expect(container.querySelector('[data-wall-glow]')?.getAttribute('data-glow-width')).toBe('210');
        expect(container.querySelector('[data-wall-glow]')?.getAttribute('data-glow-readable-zone')).toBe('full');
        expect(JSON.parse(nativeTitle.getAttribute('data-style') ?? '{}')).toMatchObject({
          flexShrink: 1,
          minWidth: 0,
          maxWidth: '100%',
          overflow: 'hidden',
          height: 38,
          borderRadius: 19,
          backgroundColor: wallGlowSurfaces[scheme].base,
          borderColor: wallGlowSurfaces[scheme].border,
        });
        for (const label of container.querySelectorAll('[data-text]')) {
          expect(label.getAttribute('data-color')).toBe(wallGlowSurfaces[scheme].label);
          expect(JSON.parse(label.getAttribute('data-style') ?? '{}')).toMatchObject({
            textShadowColor: scheme === 'dark' ? 'rgba(0, 0, 0, 0.6)' : 'rgba(255, 255, 255, 0.6)',
            textShadowOffset: { width: 0, height: 1 },
            textShadowRadius: 1.5,
          });
        }
        const decoration = container.querySelector('[data-wall-glow]')?.parentElement;
        expect(decoration?.getAttribute('data-a11y-hidden')).toBe('true');
        expect(decoration?.getAttribute('data-pointer-events')).toBe('none');
      },
    );

    it('does not rebuild on repeated same-size native layout reports', () => {
      spies.glowInput = TEST_GLOW;
      const { container } = render(<BoardHeldCapsule ledless={false} />);
      fireEvent.doubleClick(container.firstElementChild!);
      fireEvent.doubleClick(container.firstElementChild!);
      const settledCalls = spies.glowCalls;
      fireEvent.doubleClick(container.firstElementChild!);
      expect(spies.glowCalls).toBe(settledCalls);
      spies.layoutWidth = 80;
      fireEvent.doubleClick(container.firstElementChild!);
      expect(container.querySelector('[data-wall-glow]')?.getAttribute('data-glow-width')).toBe('80');
    });

    it('keeps the LED-less climb in its existing brand surface without starting glow reads', () => {
      spies.glowInput = TEST_GLOW;
      const { container } = render(<BoardHeldCapsule ledless />);
      fireEvent.doubleClick(container.firstElementChild!);
      expect(spies.glowEnabled).toBe(false);
      expect(container.querySelector('[data-wall-glow]')).toBeNull();
      expect(container.querySelector('[data-glass-surface]')?.getAttribute('data-glass-tint')).toBe(
        'rgba(109, 40, 217, 0.14)',
      );
    });

    it('retains amber when holds or board geometry are unavailable after layout', () => {
      const { container } = render(<BoardHeldCapsule ledless={false} />);
      fireEvent.doubleClick(container.firstElementChild!);
      expect(container.querySelector('[data-wall-glow]')).toBeNull();
      expect(container.querySelector('[data-glass-surface]')?.getAttribute('data-glass-tint')).toBe(
        'rgba(251, 191, 36, 0.14)',
      );
    });

    it('reuses the native title when the current climb or mirror orientation changes', () => {
      spies.glowInput = TEST_GLOW;
      const capsule = (uuid: string, name: string, mirrored: boolean) => (
        <NativeHeaderActionContext.Provider value={true}>
          <HeldClimbCapsule
            climb={{
              uuid,
              name,
              mirrored,
              difficulty: 'V7',
              frames: '',
              setter_username: 'setter',
              angle: 40,
              ascensionist_count: 0,
              quality_average: '',
              stars: 0,
              difficulty_error: '',
              benchmark_difficulty: null,
            }}
            ledless={false}
            toneColor={WARNING}
            compact={false}
            onPress={spies.lightbulbPress}
            onLongPress={spies.lightbulbLongPress}
            accessibilityActions={undefined}
            onAccessibilityAction={() => {}}
            accessibilityHint=""
          />
        </NativeHeaderActionContext.Provider>
      );
      const { container, rerender } = render(capsule('climb-1', 'Kish Mud Prison', false));
      const nativeTitle = container.firstElementChild;
      fireEvent.doubleClick(nativeTitle!);
      spies.glowInput = { ...TEST_GLOW, key: 'climb-2-mirrored' };
      rerender(capsule('climb-2', 'Next climb', true));
      expect(container.firstElementChild).toBe(nativeTitle);
      expect(container.querySelector('[data-wall-glow]')?.getAttribute('data-wall-glow')).toBe('climb-2-mirrored');
      expect(spies.glowMirrored).toBe(true);
      expect(spies.enterAnimation).not.toHaveBeenCalled();
    });

    it('preserves tap, long-press and Large Content Viewer actions on the patterned surface', () => {
      spies.glowInput = TEST_GLOW;
      const { container } = render(<BoardHeldCapsule ledless={false} />);
      fireEvent.doubleClick(container.firstElementChild!);
      fireEvent.click(container.querySelector('[data-pressable]')!);
      expect(spies.lightbulbPress).toHaveBeenCalledOnce();
      fireEvent.contextMenu(container.querySelector('[data-pressable]')!);
      fireEvent.doubleClick(container.querySelector('[data-label-viewer]')!);
      expect(spies.lightbulbLongPress).toHaveBeenCalledTimes(2);
      expect(spies.lightbulbPress).toHaveBeenCalledOnce();
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
