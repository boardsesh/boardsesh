// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LayoutChangeEvent } from 'react-native';
import type { SwipeDismissAnimation } from '../../src/components/play-drawer/use-drawer-dismiss-gesture';

const router = vi.hoisted(() => ({ dismiss: vi.fn() }));
const navigation = vi.hoisted(() => ({ setOptions: vi.fn(), isFocused: vi.fn(() => true) }));
const onClosed = vi.hoisted(() => vi.fn());
const player = vi.hoisted(() => ({ swipeDismiss: null as SwipeDismissAnimation | null }));
const surface = vi.hoisted(() => ({ onLayout: null as ((event: LayoutChangeEvent) => void) | null }));
const boardConfig = { boardName: 'kilter', layoutId: 1, sizeId: 1, setIds: '1', angle: 40 };

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-testid': 'backing' }, children),
  StyleSheet: { create: (styles: unknown) => styles, absoluteFill: {} },
  useWindowDimensions: () => ({ height: 900, width: 400 }),
}));
vi.mock('react-native-reanimated', async () => {
  const { useRef } = await import('react');
  return {
    default: {
      View: ({
        children,
        style,
        onLayout,
      }: {
        children?: ReactNode;
        style: unknown;
        onLayout: typeof surface.onLayout;
      }) => {
        surface.onLayout = onLayout;
        return createElement('div', { 'data-testid': 'moving-surface', 'data-style': JSON.stringify(style) }, children);
      },
    },
    useSharedValue: (initial: unknown) => useRef({ value: initial }).current,
    useAnimatedStyle: (factory: () => unknown) => factory(),
    withSpring: (target: number) => target,
    runOnUI: (callback: () => void) => callback,
    runOnJS: (callback: () => void) => callback,
  };
});
vi.mock('expo-router', () => ({ useRouter: () => router, useNavigation: () => navigation }));
vi.mock('../../src/components/GlassSurface', () => ({
  GlassSurface: () => createElement('div', { 'data-testid': 'glass' }),
}));
vi.mock('../../src/components/play-drawer', () => ({
  PlayDrawer: ({ swipeDismiss, onClose }: { swipeDismiss: SwipeDismissAnimation; onClose: () => void }) => {
    player.swipeDismiss = swipeDismiss;
    return createElement('button', { onClick: onClose }, 'Close player');
  },
}));
vi.mock('../../src/components/play-drawer/QueueSheet', () => ({ QueueSheet: () => null }));
vi.mock('../../src/components/ble/DevicePickerSheetHost', () => ({ DevicePickerSheetHost: () => null }));
vi.mock('../../src/components/play-drawer/use-queue-sheet-handlers', () => ({ useQueueSheetHandlers: () => ({}) }));
vi.mock('../../src/providers/drawer-host-provider', () => ({
  usePlayDrawerRoute: () => ({ activeBoardConfig: boardConfig, onPlayDrawerClosed: onClosed }),
  useDrawerHost: () => ({ boardConfig }),
}));
vi.mock('../../src/providers/queue-provider', () => ({
  useQueueActions: () => ({}),
  useQueueSessionControls: () => ({}),
}));
vi.mock('../../src/providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { secondaryBackground: '#fff' }, colorScheme: 'light' }),
}));
vi.mock('../../src/theme/colors', () => ({ playDrawerMaterialTint: { light: 'transparent', dark: 'transparent' } }));
vi.mock('../../src/components/create-climb/use-player-dismiss-and-wait', () => ({
  usePlayerDismissAndWait: () => vi.fn(),
}));
vi.mock('../../src/providers/sheet-presentation-provider', () => ({ dismissManagedSheetAndWait: vi.fn() }));

import PlayScreen from '../play';

const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
function flushFrame() {
  const scheduled = [...frames.values()];
  frames.clear();
  act(() => scheduled.forEach((callback) => callback(0)));
}

function renderPlayer() {
  const rendered = render(createElement(PlayScreen));
  flushFrame(); // Existing cheap-first-frame content gate.
  const animation = player.swipeDismiss;
  if (!animation) throw new Error('player did not receive the route animation');
  return { ...rendered, animation };
}

beforeEach(() => {
  vi.clearAllMocks();
  navigation.isFocused.mockReturnValue(true);
  frames.clear();
  nextFrame = 0;
  player.swipeDismiss = null;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => frames.delete(handle));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('player swipe dismissal', () => {
  it('keeps backing, glass and player inside the same translated surface', () => {
    const { animation } = renderPlayer();
    const movingSurface = screen.getByTestId('moving-surface');
    expect(movingSurface.contains(screen.getByTestId('backing'))).toBe(true);
    expect(movingSurface.contains(screen.getByTestId('glass'))).toBe(true);
    expect(movingSurface.contains(screen.getByRole('button', { name: 'Close player' }))).toBe(true);
    act(() => {
      animation.translateY.value = 900;
      animation.onComplete();
    });
    expect(movingSurface.getAttribute('data-style')).toContain('"translateY":900');
  });

  it('uses measured route height as the offscreen target', () => {
    const { animation } = renderPlayer();
    act(() => surface.onLayout?.({ nativeEvent: { layout: { height: 920 } } } as LayoutChangeEvent));
    expect(animation.height.value).toBe(920);
  });

  it('preserves the native chevron close without changing route animation options', () => {
    renderPlayer();
    fireEvent.click(screen.getByRole('button', { name: 'Close player' }));
    expect(router.dismiss).toHaveBeenCalledTimes(1);
    expect(navigation.setOptions).not.toHaveBeenCalled();
  });

  it('does not navigate until the spring finishes and native options have a separate frame to commit', () => {
    const { animation } = renderPlayer();
    animation.isDismissing.value = true;
    expect(router.dismiss).not.toHaveBeenCalled();
    expect(navigation.setOptions).not.toHaveBeenCalled();
    act(() => animation.onComplete());
    expect(navigation.setOptions).toHaveBeenCalledWith({ animation: 'none' });
    expect(router.dismiss).not.toHaveBeenCalled();
    flushFrame();
    expect(router.dismiss).not.toHaveBeenCalled();
    flushFrame();
    expect(router.dismiss).toHaveBeenCalledTimes(1);
    expect(onClosed).not.toHaveBeenCalled();
  });

  it('ignores button taps during a committed swipe and duplicate completions', () => {
    const { animation } = renderPlayer();
    animation.isDismissing.value = true;
    fireEvent.click(screen.getByRole('button', { name: 'Close player' }));
    expect(router.dismiss).not.toHaveBeenCalled();
    act(() => {
      animation.onComplete();
      animation.onComplete();
    });
    flushFrame();
    flushFrame();
    expect(router.dismiss).toHaveBeenCalledTimes(1);
  });

  it('ignores a late completion after unmount and resets host state once', () => {
    const { animation, unmount } = renderPlayer();
    unmount();
    act(() => animation.onComplete());
    flushFrame();
    flushFrame();
    expect(router.dismiss).not.toHaveBeenCalled();
    expect(navigation.setOptions).not.toHaveBeenCalled();
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it('cancels pending removal when another close unmounts the route', () => {
    const { animation, unmount } = renderPlayer();
    act(() => animation.onComplete());
    flushFrame();
    unmount();
    flushFrame();
    expect(router.dismiss).not.toHaveBeenCalled();
  });

  it('restores the player if a newer modal covers it before removal', () => {
    const { animation } = renderPlayer();
    animation.translateY.value = 900;
    animation.isDismissing.value = true;
    act(() => animation.onComplete());
    flushFrame();
    navigation.isFocused.mockReturnValue(false);
    flushFrame();
    expect(router.dismiss).not.toHaveBeenCalled();
    expect(navigation.setOptions).toHaveBeenLastCalledWith({ animation: 'slide_from_bottom' });
    expect(animation.translateY.value).toBe(0);
    expect(animation.isDismissing.value).toBe(false);

    navigation.isFocused.mockReturnValue(true);
    act(() => animation.onComplete());
    flushFrame();
    flushFrame();
    expect(router.dismiss).toHaveBeenCalledTimes(1);
  });
});
