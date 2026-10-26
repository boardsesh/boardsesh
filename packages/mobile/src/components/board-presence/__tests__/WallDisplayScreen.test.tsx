// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const cfg = vi.hoisted(() => ({
  screenReaderEnabled: false,
  router: { back: vi.fn(), push: vi.fn(), replace: vi.fn(), canGoBack: vi.fn() },
  keepAwake: vi.fn(),
}));

type HostProps = {
  children?: ReactNode;
  testID?: string;
  onTouchStart?: () => void;
  pointerEvents?: string;
  accessibilityElementsHidden?: boolean;
};

vi.mock('react-native', () => ({
  View: ({ children, onTouchStart }: HostProps) => createElement('div', { 'data-root': true, onTouchStart }, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('react-native-reanimated', () => ({
  default: {
    View: ({ children, testID, pointerEvents, accessibilityElementsHidden }: HostProps) =>
      createElement(
        'div',
        {
          'data-testid': testID,
          'data-pointer-events': pointerEvents,
          'data-a11y-hidden': String(accessibilityElementsHidden),
        },
        children,
      ),
  },
  useAnimatedStyle: () => ({}),
  useReducedMotion: () => false,
  useSharedValue: (value: number) => ({ value }),
  withTiming: (value: number) => value,
}));
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
vi.mock('../../../hooks/use-screen-reader-enabled', () => ({
  useScreenReaderEnabled: () => cfg.screenReaderEnabled,
}));
vi.mock('../../../lib/routing/scoped-navigation', () => ({ useScopedRouter: () => cfg.router }));

import { WallDisplayScreen, WALL_DISPLAY_CONTROLS_VISIBLE_MS } from '../WallDisplayScreen';

const controls = (container: HTMLElement) => container.querySelector('[data-testid="wall-display-controls"]')!;

describe('WallDisplayScreen', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    cfg.screenReaderEnabled = false;
    cfg.router.back.mockReset();
    cfg.router.push.mockReset();
    cfg.router.replace.mockReset();
    cfg.router.canGoBack.mockReset().mockReturnValue(true);
    cfg.keepAwake.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the kiosk and keeps the screen awake while it is up', () => {
    const { container } = render(<WallDisplayScreen />);

    expect(container.querySelector('[data-kiosk]')).not.toBeNull();
    expect(cfg.keepAwake).toHaveBeenCalledWith(true, 'wall');
  });

  it('fades Exit and Settings after a few seconds and brings them back on a touch', () => {
    const { container } = render(<WallDisplayScreen />);
    expect(controls(container).getAttribute('data-pointer-events')).toBe('box-none');
    expect(controls(container).getAttribute('data-a11y-hidden')).toBe('false');

    act(() => {
      vi.advanceTimersByTime(WALL_DISPLAY_CONTROLS_VISIBLE_MS);
    });
    // Hidden controls take no taps and leave the accessibility tree.
    expect(controls(container).getAttribute('data-pointer-events')).toBe('none');
    expect(controls(container).getAttribute('data-a11y-hidden')).toBe('true');

    fireEvent.touchStart(container.querySelector('[data-root]')!);
    expect(controls(container).getAttribute('data-pointer-events')).toBe('box-none');
  });

  it('keeps the controls up while a screen reader runs', () => {
    cfg.screenReaderEnabled = true;
    const { container } = render(<WallDisplayScreen />);

    act(() => {
      vi.advanceTimersByTime(WALL_DISPLAY_CONTROLS_VISIBLE_MS * 10);
    });
    expect(controls(container).getAttribute('data-pointer-events')).toBe('box-none');
  });

  it('leaves with Exit, falling back to the app root when the display is the only screen', () => {
    const { getByRole } = render(<WallDisplayScreen />);
    fireEvent.click(getByRole('button', { name: 'mobile.boardPresence.wallDisplay.exitA11y' }));
    expect(cfg.router.back).toHaveBeenCalledOnce();

    cfg.router.canGoBack.mockReturnValue(false);
    fireEvent.click(getByRole('button', { name: 'mobile.boardPresence.wallDisplay.exitA11y' }));
    expect(cfg.router.replace).toHaveBeenCalledWith('/');
  });

  it("opens Settings inside the display's own stack", () => {
    const { getByRole } = render(<WallDisplayScreen />);
    fireEvent.click(getByRole('button', { name: 'mobile.settings.title' }));
    expect(cfg.router.push).toHaveBeenCalledWith('/settings');
  });
});
