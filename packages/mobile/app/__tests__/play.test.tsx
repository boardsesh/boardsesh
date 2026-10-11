// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode, type Ref } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LayoutChangeEvent } from 'react-native';
import type { SwipeDismissAnimation } from '../../src/components/play-drawer/use-drawer-dismiss-gesture';
import type { QueueSheetHandle } from '../../src/components/play-drawer/QueueSheet';
import type { PlayDrawerOpenTarget } from '../../src/components/play-drawer';
import type { DismissAndWaitResult } from '../../src/providers/sheet-presentation-provider';

const router = vi.hoisted(() => ({ dismiss: vi.fn() }));
const navigation = vi.hoisted(() => ({
  setOptions: vi.fn(),
  isFocused: vi.fn(() => true),
  beforeRemove: null as ((event: { defaultPrevented: boolean }) => void) | null,
  addListener: vi.fn<(event: string, listener: (event: { defaultPrevented: boolean }) => void) => () => void>(),
}));
const onClosed = vi.hoisted(() => vi.fn());
const routeTarget = vi.hoisted(() => ({ current: null as PlayDrawerOpenTarget | null, consumed: vi.fn() }));
const player = vi.hoisted(() => ({
  swipeDismiss: null as SwipeDismissAnimation | null,
  dismissAndWait: null as (() => Promise<DismissAndWaitResult>) | null,
  nativeWait: vi.fn<() => Promise<DismissAndWaitResult>>(),
}));
const surface = vi.hoisted(() => ({ onLayout: null as ((event: LayoutChangeEvent) => void) | null }));
const queueSheet = vi.hoisted(() => ({ mounted: 0, present: vi.fn(), dismiss: vi.fn(), dismissAndWait: vi.fn() }));
const boardConfig = { boardName: 'kilter', layoutId: 1, sizeId: 1, setIds: '1', angle: 40 };

// The play route now asks which boards stand at this gym, to decide whether a
// foreign climb blocks or invites. Both are React Query hooks this harness does
// not mount; an empty set means "nothing else in reach", i.e. today's behaviour.
vi.mock('../../src/providers/queue/use-reachable-board-keys', () => ({
  useReachableBoardKeys: () => new Set<string>(),
}));
vi.mock('../../src/lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: null }),
}));

// The launch hold is covered by its own suite; here the screen renders as is.
vi.mock('../../src/components/launch-update/hold-until-launch-ready', () => ({
  holdUntilLaunchReady: <Screen,>(Screen: Screen) => Screen,
}));

vi.mock('react-native', () => ({
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
    cancelAnimation: vi.fn(),
    runOnUI: (callback: () => void) => callback,
    runOnJS: (callback: () => void) => callback,
  };
});
vi.mock('expo-router', () => ({
  useRouter: () => router,
  useNavigation: () => navigation,
  Link: { AppleZoomTarget: ({ children }: { children: ReactNode }) => children },
}));
vi.mock('../../src/components/ScreenBackground', () => ({
  ScreenBackground: () => createElement('div', { 'data-testid': 'background' }),
}));
vi.mock('../../src/components/play-drawer', () => ({
  PlayDrawer: ({
    swipeDismiss,
    onClose,
    onOpenQueue,
    dismissPlayerAndWait,
  }: {
    swipeDismiss: SwipeDismissAnimation;
    onClose: () => void;
    onOpenQueue: () => void;
    dismissPlayerAndWait: () => Promise<DismissAndWaitResult>;
  }) => {
    player.swipeDismiss = swipeDismiss;
    player.dismissAndWait = dismissPlayerAndWait;
    return createElement(
      'div',
      null,
      createElement('button', { onClick: onClose }, 'Close player'),
      createElement('button', { onClick: onOpenQueue }, 'Open queue'),
    );
  },
}));
vi.mock('../../src/components/play-drawer/QueueSheet', async () => {
  const { useImperativeHandle, useEffect } = await import('react');
  return {
    QueueSheet: ({ ref }: { ref: Ref<QueueSheetHandle> }) => {
      useImperativeHandle(ref, () => ({
        present: queueSheet.present,
        dismiss: queueSheet.dismiss,
        dismissAndWait: queueSheet.dismissAndWait,
      }));
      useEffect(() => {
        queueSheet.mounted += 1;
      }, []);
      return createElement('div', { 'data-testid': 'queue-sheet' });
    },
  };
});
vi.mock('../../src/components/ble/DevicePickerSheetHost', () => ({ DevicePickerSheetHost: () => null }));
vi.mock('../../src/components/play-drawer/use-queue-sheet-handlers', () => ({ useQueueSheetHandlers: () => ({}) }));
vi.mock('../../src/providers/drawer-host-provider', () => ({
  usePlayDrawerRoute: () => ({
    activeBoardConfig: boardConfig,
    onPlayDrawerClosed: onClosed,
    onPlayDrawerTargetConsumed: routeTarget.consumed,
    playTarget: routeTarget.current,
  }),
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
  usePlayerDismissAndWait: () => player.nativeWait,
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
  const animation = player.swipeDismiss;
  if (!animation) throw new Error('player did not receive the route animation');
  return { ...rendered, animation };
}

beforeEach(() => {
  queueSheet.mounted = 0;
  vi.clearAllMocks();
  navigation.isFocused.mockReturnValue(true);
  navigation.beforeRemove = null;
  navigation.addListener.mockImplementation((_event, listener) => {
    navigation.beforeRemove = listener;
    return () => {
      if (navigation.beforeRemove === listener) navigation.beforeRemove = null;
    };
  });
  frames.clear();
  nextFrame = 0;
  player.swipeDismiss = null;
  player.dismissAndWait = null;
  player.nativeWait.mockReset().mockResolvedValue({ status: 'dismissed' });
  routeTarget.current = null;
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
  it('restores a freshly opened target while the offscreen swipe pop is pending', () => {
    routeTarget.current = { nonce: 1, climb: { uuid: 'first' } } as PlayDrawerOpenTarget;
    const { animation, rerender } = renderPlayer();
    animation.translateY.value = 900;
    animation.isDismissing.value = true;
    act(() => animation.onComplete());
    flushFrame();
    routeTarget.current = { nonce: 2, climb: { uuid: 'fresh' } } as PlayDrawerOpenTarget;
    rerender(createElement(PlayScreen));
    expect(animation.translateY.value).toBe(0);
    expect(animation.isDismissing.value).toBe(false);
    flushFrame();
    flushFrame();
    expect(router.dismiss).not.toHaveBeenCalled();
    expect(navigation.setOptions).toHaveBeenLastCalledWith({ animation: 'slide_from_bottom' });
  });

  it('retires only the consumed target owned by the unmounting route instance', () => {
    routeTarget.current = { nonce: 1, climb: { uuid: 'first' } } as PlayDrawerOpenTarget;
    const firstRoute = renderPlayer();
    routeTarget.current = { nonce: 2, climb: { uuid: 'fresh' } } as PlayDrawerOpenTarget;
    const secondRoute = renderPlayer();
    expect(routeTarget.consumed).toHaveBeenLastCalledWith(2);
    firstRoute.unmount();
    expect(onClosed).toHaveBeenLastCalledWith(1);
    secondRoute.unmount();
  });

  it('leaves a fresh target unconsumed after the old native pop has already been requested', () => {
    routeTarget.current = { nonce: 1, climb: { uuid: 'first' } } as PlayDrawerOpenTarget;
    const { rerender, unmount } = renderPlayer();
    fireEvent.click(screen.getByRole('button', { name: 'Close player' }));
    expect(router.dismiss).toHaveBeenCalledTimes(1);
    routeTarget.current = { nonce: 2, climb: { uuid: 'fresh' } } as PlayDrawerOpenTarget;
    rerender(createElement(PlayScreen));
    expect(routeTarget.consumed).toHaveBeenCalledTimes(1);
    expect(routeTarget.consumed).toHaveBeenLastCalledWith(1);
    unmount();
    expect(onClosed).toHaveBeenLastCalledWith(1);
  });

  it('keeps a valid swipe pop pending when the same opener rerenders for a queued climb change', () => {
    routeTarget.current = { nonce: 1, climb: { uuid: 'first' } } as PlayDrawerOpenTarget;
    const { animation, rerender } = renderPlayer();
    animation.isDismissing.value = true;
    act(() => animation.onComplete());
    routeTarget.current = { nonce: 1, climb: { uuid: 'queue-swap' } } as PlayDrawerOpenTarget;
    rerender(createElement(PlayScreen));
    expect(animation.isDismissing.value).toBe(true);
    flushFrame();
    flushFrame();
    expect(router.dismiss).toHaveBeenCalledTimes(1);
  });

  it('keeps a fresh target unconsumed during the route-owned programmatic dismiss waiter', async () => {
    routeTarget.current = { nonce: 1, climb: { uuid: 'first' } } as PlayDrawerOpenTarget;
    const { rerender, unmount } = renderPlayer();
    await act(async () => {
      await player.dismissAndWait?.();
    });
    expect(player.nativeWait).toHaveBeenCalledTimes(1);
    routeTarget.current = { nonce: 2, climb: { uuid: 'fresh' } } as PlayDrawerOpenTarget;
    rerender(createElement(PlayScreen));
    expect(routeTarget.consumed).toHaveBeenLastCalledWith(1);
    expect(routeTarget.consumed).toHaveBeenCalledTimes(1);
    unmount();
    expect(onClosed).toHaveBeenLastCalledWith(1);
  });

  it('restores a fresh target when the programmatic native dismiss aborts', async () => {
    let finish: (result: DismissAndWaitResult) => void = () => {};
    player.nativeWait.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    routeTarget.current = { nonce: 1, climb: { uuid: 'first' } } as PlayDrawerOpenTarget;
    const { rerender, animation } = renderPlayer();
    let waiting: Promise<DismissAndWaitResult> | undefined;
    act(() => {
      waiting = player.dismissAndWait?.();
    });
    routeTarget.current = { nonce: 2, climb: { uuid: 'fresh' } } as PlayDrawerOpenTarget;
    rerender(createElement(PlayScreen));
    expect(routeTarget.consumed).toHaveBeenLastCalledWith(1);
    await act(async () => {
      finish({ status: 'aborted' });
      await waiting;
    });
    expect(routeTarget.consumed).toHaveBeenLastCalledWith(2);
    expect(animation.translateY.value).toBe(0);
    expect(animation.isDismissing.value).toBe(false);
  });

  it('restores a native request that emits its own beforeRemove event and then aborts', async () => {
    player.nativeWait.mockImplementation(async () => {
      navigation.beforeRemove?.({ defaultPrevented: false });
      return { status: 'aborted' };
    });
    routeTarget.current = { nonce: 1, climb: { uuid: 'first' } } as PlayDrawerOpenTarget;
    const { rerender } = renderPlayer();
    await act(async () => {
      await player.dismissAndWait?.();
    });
    routeTarget.current = { nonce: 2, climb: { uuid: 'fresh' } } as PlayDrawerOpenTarget;
    rerender(createElement(PlayScreen));
    expect(routeTarget.consumed).toHaveBeenLastCalledWith(2);
  });

  it('keeps a later native removal owned after the first request emits its event and aborts', async () => {
    let finish: (result: DismissAndWaitResult) => void = () => {};
    player.nativeWait.mockImplementation(
      () =>
        new Promise((resolve) => {
          navigation.beforeRemove?.({ defaultPrevented: false });
          finish = resolve;
        }),
    );
    routeTarget.current = { nonce: 1, climb: { uuid: 'first' } } as PlayDrawerOpenTarget;
    const { rerender } = renderPlayer();
    let waiting: Promise<DismissAndWaitResult> | undefined;
    act(() => {
      waiting = player.dismissAndWait?.();
    });
    act(() => navigation.beforeRemove?.({ defaultPrevented: false }));
    await act(async () => {
      finish({ status: 'aborted' });
      await waiting;
    });
    routeTarget.current = { nonce: 2, climb: { uuid: 'fresh' } } as PlayDrawerOpenTarget;
    rerender(createElement(PlayScreen));
    expect(routeTarget.consumed).toHaveBeenLastCalledWith(1);
    expect(routeTarget.consumed).toHaveBeenCalledTimes(1);
  });

  it('aborts an old programmatic handoff when a fresh opener arrives during its native wait', async () => {
    let finish: (result: DismissAndWaitResult) => void = () => {};
    player.nativeWait.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    routeTarget.current = { nonce: 1, climb: { uuid: 'first' } } as PlayDrawerOpenTarget;
    const { rerender } = renderPlayer();
    let waiting: Promise<DismissAndWaitResult> | undefined;
    act(() => {
      waiting = player.dismissAndWait?.();
    });
    routeTarget.current = { nonce: 2, climb: { uuid: 'fresh' } } as PlayDrawerOpenTarget;
    rerender(createElement(PlayScreen));
    await act(async () => {
      finish({ status: 'dismissed' });
      expect(await waiting).toEqual({ status: 'aborted' });
    });
    expect(routeTarget.consumed).toHaveBeenLastCalledWith(1);
  });

  it('rejects a programmatic dismiss callback captured by the previous opener', async () => {
    routeTarget.current = { nonce: 1, climb: { uuid: 'first' } } as PlayDrawerOpenTarget;
    const { rerender } = renderPlayer();
    const previousWait = player.dismissAndWait;
    routeTarget.current = { nonce: 2, climb: { uuid: 'fresh' } } as PlayDrawerOpenTarget;
    rerender(createElement(PlayScreen));
    await act(async () => {
      expect(await previousWait?.()).toEqual({ status: 'aborted' });
    });
    expect(player.nativeWait).not.toHaveBeenCalled();
  });

  it('preserves a pending opener when native back removes the route', () => {
    routeTarget.current = { nonce: 1, climb: { uuid: 'first' } } as PlayDrawerOpenTarget;
    const { rerender, unmount } = renderPlayer();
    act(() => navigation.beforeRemove?.({ defaultPrevented: false }));
    routeTarget.current = { nonce: 2, climb: { uuid: 'fresh' } } as PlayDrawerOpenTarget;
    rerender(createElement(PlayScreen));
    expect(routeTarget.consumed).toHaveBeenLastCalledWith(1);
    expect(routeTarget.consumed).toHaveBeenCalledTimes(1);
    unmount();
    expect(onClosed).toHaveBeenLastCalledWith(1);
  });

  it('recovers a fresh target when another listener prevents native back removal', async () => {
    routeTarget.current = { nonce: 1, climb: { uuid: 'first' } } as PlayDrawerOpenTarget;
    const { rerender } = renderPlayer();
    act(() => {
      const event = { defaultPrevented: false };
      navigation.beforeRemove?.(event);
      event.defaultPrevented = true;
    });
    routeTarget.current = { nonce: 2, climb: { uuid: 'fresh' } } as PlayDrawerOpenTarget;
    rerender(createElement(PlayScreen));
    await act(async () => {
      await Promise.resolve();
    });
    expect(routeTarget.consumed).toHaveBeenLastCalledWith(2);
    expect(router.dismiss).not.toHaveBeenCalled();
  });

  it('does not let a prevented removal restore a later valid removal for the same opener', async () => {
    routeTarget.current = { nonce: 1, climb: { uuid: 'first' } } as PlayDrawerOpenTarget;
    const { rerender } = renderPlayer();
    act(() => {
      navigation.beforeRemove?.({ defaultPrevented: true });
      navigation.beforeRemove?.({ defaultPrevented: false });
    });
    await act(async () => {
      await Promise.resolve();
    });
    routeTarget.current = { nonce: 2, climb: { uuid: 'fresh' } } as PlayDrawerOpenTarget;
    rerender(createElement(PlayScreen));
    expect(routeTarget.consumed).toHaveBeenLastCalledWith(1);
    expect(routeTarget.consumed).toHaveBeenCalledTimes(1);
  });

  it('does not let an old aborted waiter restore a later native removal for the same opener', async () => {
    let finishFirst: (result: DismissAndWaitResult) => void = () => {};
    player.nativeWait.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = resolve;
        }),
    );
    player.nativeWait.mockImplementationOnce(() => new Promise(() => {}));
    routeTarget.current = { nonce: 1, climb: { uuid: 'first' } } as PlayDrawerOpenTarget;
    const { rerender } = renderPlayer();
    let firstWait: Promise<DismissAndWaitResult> | undefined;
    act(() => {
      firstWait = player.dismissAndWait?.();
    });
    act(() => navigation.beforeRemove?.({ defaultPrevented: true }));
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      void player.dismissAndWait?.();
    });
    expect(player.nativeWait).toHaveBeenCalledTimes(2);
    await act(async () => {
      finishFirst({ status: 'aborted' });
      await firstWait;
    });
    routeTarget.current = { nonce: 2, climb: { uuid: 'fresh' } } as PlayDrawerOpenTarget;
    rerender(createElement(PlayScreen));
    expect(routeTarget.consumed).toHaveBeenLastCalledWith(1);
    expect(routeTarget.consumed).toHaveBeenCalledTimes(1);
  });

  it('mounts the player core in the first commit and creates its queue host on the first queue press', () => {
    render(createElement(PlayScreen));
    expect(screen.getByRole('button', { name: 'Close player' })).toBeTruthy();
    expect(player.swipeDismiss).not.toBeNull();
    expect(frames.size).toBe(0);
    expect(queueSheet.mounted).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Open queue' }));
    expect(queueSheet.mounted).toBe(1);
    expect(queueSheet.present).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Open queue' }));
    expect(queueSheet.mounted).toBe(1);
    expect(queueSheet.present).toHaveBeenCalledTimes(2);
  });
  it('keeps the background and player inside the same translated surface', () => {
    const { animation } = renderPlayer();
    const movingSurface = screen.getByTestId('moving-surface');
    expect(movingSurface.contains(screen.getByTestId('background'))).toBe(true);
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
