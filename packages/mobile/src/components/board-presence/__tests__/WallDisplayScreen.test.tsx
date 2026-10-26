// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { NativeShortcutCommand } from '../../../../modules/spray-editor-input/src/index';

const cfg = vi.hoisted(() => ({
  isFocused: true,
  assistiveTechnologyEnabled: false,
  router: { back: vi.fn(), push: vi.fn(), replace: vi.fn(), canGoBack: vi.fn() },
  keepAwake: vi.fn(),
  keyScope: null as null | {
    commands: readonly NativeShortcutCommand[];
    onShortcut: (event: { nativeEvent: { id: string } }) => void;
  },
}));

type HostProps = { children?: ReactNode; testID?: string; onTouchStart?: () => void; pointerEvents?: string };

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: ({ children, onTouchStart }: HostProps) =>
    createElement('div', { 'data-root': onTouchStart ? true : undefined, onTouchStart }, children),
  StyleSheet: { create: (styles: unknown) => styles, absoluteFill: {} },
}));
vi.mock('react-native-reanimated', () => ({
  default: {
    View: ({ children, testID, pointerEvents }: HostProps) =>
      createElement('div', { 'data-testid': testID, 'data-pointer-events': pointerEvents }, children),
  },
  useAnimatedStyle: () => ({}),
  useReducedMotion: () => false,
  useSharedValue: (value: number) => ({ value }),
  withTiming: (value: number) => value,
}));
vi.mock('expo-router', () => ({ useIsFocused: () => cfg.isFocused }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 2: 8, 3: 12, 4: 16 } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 20, left: 0, right: 0 }),
}));
vi.mock('../WallScreen', () => ({ WallScreen: () => createElement('div', { 'data-kiosk': true }) }));
vi.mock('../../Button', () => ({
  Button: ({
    title,
    accessibilityLabel,
    onPress,
  }: {
    title: string;
    accessibilityLabel?: string;
    onPress: () => void;
  }) => createElement('button', { 'aria-label': accessibilityLabel ?? title, onClick: onPress }, title),
}));
vi.mock('../../../hooks/use-keep-awake-while', () => ({ useKeepAwakeWhile: cfg.keepAwake }));
vi.mock('../../../hooks/use-assistive-technology-enabled', () => ({
  useAssistiveTechnologyEnabled: () => cfg.assistiveTechnologyEnabled,
}));
vi.mock('../../../lib/routing/scoped-navigation', () => ({ useScopedRouter: () => cfg.router }));
vi.mock('../../../../modules/spray-editor-input/src/index', () => ({
  NativeSprayEditorKeyScope: (props: {
    children?: ReactNode;
    commands: readonly NativeShortcutCommand[];
    onShortcut: (event: { nativeEvent: { id: string } }) => void;
  }) => {
    cfg.keyScope = { commands: props.commands, onShortcut: props.onShortcut };
    return createElement('div', { 'data-key-scope': true }, props.children);
  },
}));

import { WallDisplayScreen, WALL_DISPLAY_CONTROLS_VISIBLE_MS } from '../WallDisplayScreen';

const exitButton = { name: 'mobile.boardPresence.wallDisplay.exitA11y' };

describe('WallDisplayScreen', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    cfg.isFocused = true;
    cfg.assistiveTechnologyEnabled = false;
    cfg.keyScope = null;
    cfg.router.back.mockReset();
    cfg.router.push.mockReset();
    cfg.router.replace.mockReset();
    cfg.router.canGoBack.mockReset().mockReturnValue(true);
    cfg.keepAwake.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the kiosk and keeps the screen awake while the kiosk is focused', () => {
    const { container } = render(<WallDisplayScreen />);

    expect(container.querySelector('[data-kiosk]')).not.toBeNull();
    expect(cfg.keepAwake).toHaveBeenLastCalledWith(true, 'wall');
  });

  it('lets the screen dim and hands Esc back while a page is pushed over the kiosk', () => {
    cfg.isFocused = false;
    render(<WallDisplayScreen />);

    expect(cfg.keepAwake).toHaveBeenLastCalledWith(false, 'wall');
    expect(cfg.keyScope?.commands).toEqual([]);
  });

  it('fades Exit and Settings after a few seconds, keeps them reachable, and brings them back on a touch', () => {
    const { container, getByRole } = render(<WallDisplayScreen />);
    expect(container.querySelector('[data-testid="wall-display-controls"]')).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(WALL_DISPLAY_CONTROLS_VISIBLE_MS);
    });
    expect(container.querySelector('[data-testid="wall-display-controls-faded"]')).not.toBeNull();
    // Still in the tree (Switch Control, Voice Control and keyboard focus reach it).
    expect(getByRole('button', exitButton)).toBeTruthy();

    fireEvent.touchStart(container.querySelector('[data-root]')!);
    expect(container.querySelector('[data-testid="wall-display-controls"]')).not.toBeNull();
  });

  it('does not exit on a tap that lands on the faded Exit; the next tap does', () => {
    const { container, getByRole } = render(<WallDisplayScreen />);
    act(() => {
      vi.advanceTimersByTime(WALL_DISPLAY_CONTROLS_VISIBLE_MS);
    });

    fireEvent.touchStart(container.querySelector('[data-root]')!);
    fireEvent.click(getByRole('button', exitButton));
    expect(cfg.router.back).not.toHaveBeenCalled();

    fireEvent.touchStart(container.querySelector('[data-root]')!);
    fireEvent.click(getByRole('button', exitButton));
    expect(cfg.router.back).toHaveBeenCalledOnce();
  });

  it('keeps the controls up while an assistive technology runs', () => {
    cfg.assistiveTechnologyEnabled = true;
    const { container } = render(<WallDisplayScreen />);

    act(() => {
      vi.advanceTimersByTime(WALL_DISPLAY_CONTROLS_VISIBLE_MS * 10);
    });
    expect(container.querySelector('[data-testid="wall-display-controls"]')).not.toBeNull();
  });

  it('leaves with Exit, falling back to the app root when the display is the only screen', () => {
    const { getByRole } = render(<WallDisplayScreen />);
    fireEvent.click(getByRole('button', exitButton));
    expect(cfg.router.back).toHaveBeenCalledOnce();

    cfg.router.canGoBack.mockReturnValue(false);
    fireEvent.click(getByRole('button', exitButton));
    expect(cfg.router.replace).toHaveBeenCalledWith('/');
  });

  it('leaves with ⌘W or Esc from a hardware keyboard', () => {
    render(<WallDisplayScreen />);
    expect(cfg.keyScope?.commands.map(({ input, modifiers }) => [input, modifiers])).toEqual([
      ['w', ['command']],
      ['escape', []],
    ]);

    act(() => {
      cfg.keyScope?.onShortcut({ nativeEvent: { id: 'exit' } });
    });
    expect(cfg.router.back).toHaveBeenCalledOnce();
  });

  it("opens Settings inside the display's own stack", () => {
    const { getByRole } = render(<WallDisplayScreen />);
    fireEvent.click(getByRole('button', { name: 'mobile.settings.title' }));
    expect(cfg.router.push).toHaveBeenCalledWith('/settings');
  });
});
