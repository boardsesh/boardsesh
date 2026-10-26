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

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
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
vi.mock('../../../lib/haptics', () => ({ hapticLight: vi.fn() }));
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
  LargeContentViewer: ({ children, style }: { children?: ReactNode; style?: unknown }) =>
    createElement(
      'div',
      {
        'data-label-viewer': 'true',
        'data-style': JSON.stringify(Object.assign({}, ...[style].flat(10).filter(Boolean))),
      },
      children,
    ),
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    feedback,
    accessibilityRole,
    accessibilityLabel,
    accessibilityHint,
    style,
  }: {
    children?: ReactNode;
    onPress?: () => void;
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
        'data-style': JSON.stringify(Object.assign({}, ...[style].flat(10).filter(Boolean))),
        onClick: onPress,
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
    spies.nativeGlass = true;
  });

  it('says "You have the board" with a lit bulb in the amber glass tint', () => {
    const { container } = render(<BoardHeldCapsule ledless={false} canOpenControls />);
    expect(container.textContent).toContain('ble.barControl.youHaveBoard');
    expect(container.querySelector('[data-icon="lightbulb.fill"]')?.getAttribute('data-icon-color')).toBe(WARNING);
    expect(container.querySelector('[data-glass-surface]')?.getAttribute('data-glass-tint')).toBe(
      'rgba(251, 191, 36, 0.14)',
    );
  });

  it('opens the Bluetooth controls from the header, saying where it came from', () => {
    const { container } = render(<BoardHeldCapsule ledless={false} canOpenControls />);
    const button = container.querySelector('[data-pressable="true"]') as HTMLElement;
    expect(button.getAttribute('data-label')).toBe('ble.barControl.youHaveBoard');
    expect(button.getAttribute('data-hint')).toBe('ble.barControl.openControlsHint');
    fireEvent.click(button);
    expect(spies.openControls).toHaveBeenCalledWith({ surface: 'header_pill' });
  });

  it('on a board with no lights, pins in the brand tone and never claims lit LEDs', () => {
    const { container } = render(<BoardHeldCapsule ledless canOpenControls={false} />);
    expect(container.textContent).toContain('ble.barControl.wallHeldLabel');
    expect(container.querySelector('[data-icon="lightbulb.fill"]')).toBeNull();
    expect(container.querySelector('[data-icon="pin.fill"]')?.getAttribute('data-icon-color')).toBe(PRIMARY);
    expect(container.querySelector('[data-glass-surface]')?.getAttribute('data-glass-tint')).toBe(
      'rgba(109, 40, 217, 0.14)',
    );
  });

  it('reads as text, not a button, when there is no radio link to control', () => {
    const { container } = render(<BoardHeldCapsule ledless canOpenControls={false} />);
    expect(container.querySelector('[data-pressable="true"]')).toBeNull();
    expect(spies.openControls).not.toHaveBeenCalled();
  });
});
