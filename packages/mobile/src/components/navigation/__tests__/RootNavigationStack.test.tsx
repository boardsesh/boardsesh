// @vitest-environment jsdom
import { createElement, memo, useSyncExternalStore, type ReactNode } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeSprayPhotoSession, createSprayPhotoSession } from '../../../lib/spray/spray-photo-session';

const route = vi.hoisted(() => ({
  pathname: '/boards',
  photoSessionId: undefined as string | undefined,
  listeners: new Set<() => void>(),
  orientation: undefined as string | undefined,
  barsHidden: false,
  platformOS: 'android',
  isPad: false,
  width: 400,
  height: 800,
}));
vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return route.platformOS;
    },
    get isPad() {
      return route.isPad;
    },
  },
  Dimensions: { get: () => ({ width: route.width, height: route.height }) },
  useWindowDimensions: () => ({ width: route.width, height: route.height }),
}));
vi.mock('expo-router', () => ({
  useGlobalSearchParams: () => ({ photoSessionId: route.photoSessionId }),
  usePathname: () =>
    useSyncExternalStore(
      (listener) => {
        route.listeners.add(listener);
        return () => {
          route.listeners.delete(listener);
        };
      },
      () => route.pathname,
    ),
  Stack: ({
    screenOptions,
    children,
  }: {
    screenOptions: { orientation?: string; statusBarHidden?: boolean; navigationBarHidden?: boolean };
    children: ReactNode;
  }) => {
    route.orientation = screenOptions.orientation;
    route.barsHidden = Boolean(screenOptions.statusBarHidden && screenOptions.navigationBarHidden);
    return createElement('div', null, children);
  },
}));
vi.mock('../../../theme/navigation', () => ({ glassStackScreenOptions: {} }));
import { RootNavigationStack } from '../RootNavigationStack';
const FrozenProvider = memo(
  ({ children }: { children: ReactNode }) => children,
  () => true,
);
function navigate(pathname: string) {
  act(() => {
    route.pathname = pathname;
    route.listeners.forEach((listener) => listener());
  });
}
afterEach(() => {
  cleanup();
  route.pathname = '/boards';
  route.photoSessionId = undefined;
  route.platformOS = 'android';
  route.isPad = false;
  route.width = 400;
  route.height = 800;
});
describe('fullscreen native orientation', () => {
  it('unlocks attached screens below a frozen provider and restores portrait on exit', () => {
    render(createElement(FrozenProvider, null, createElement(RootNavigationStack, null, 'screen')));
    expect(route.orientation).toBe('portrait');
    navigate('/spray-led-fullscreen');
    expect(route.orientation).toBe('all');
    expect(route.barsHidden).toBe(true);
    route.width = 800;
    route.height = 400;
    navigate('/boards');
    expect(route.orientation).toBe('portrait');
    expect(route.barsHidden).toBe(false);
  });

  it.each([
    [1200, 800, 'landscape_right'],
    [800, 1200, 'portrait_up'],
  ])('locks cable for a %s by %s wall through window changes and session cleanup', (width, height, orientation) => {
    const id = createSprayPhotoSession(
      {
        viewerId: 'viewer',
        lockOrientationToWall: true,
        tools: null,
        canvas: {
          source: {
            layoutId: 1,
            versionId: 2,
            photoUrl: 'https://example.invalid/wall.jpg',
            photoExpiresAt: '2030-01-01',
            photo: { width, height },
            frame: { width, height },
            homography: [1, 0, 0, 0, 1, 0, 0, 0, 1],
            holds: [],
          },
          photoUri: 'file:///wall.jpg',
        },
      },
      vi.fn(),
    );
    route.photoSessionId = id;
    const { rerender } = render(createElement(RootNavigationStack, null, 'screen'));
    navigate('/spray-led-fullscreen');
    expect(route.orientation).toBe(orientation);
    route.width = 800;
    route.height = 400;
    rerender(createElement(RootNavigationStack, null, 'screen'));
    expect(route.orientation).toBe(orientation);
    act(() => closeSprayPhotoSession(id));
    expect(route.orientation).toBe(orientation);
    navigate('/boards');
    expect(route.orientation).toBe('portrait');
  });
  it('keeps tablet defaults after the temporary fullscreen orientation', () => {
    route.width = 800;
    route.height = 1200;
    render(createElement(RootNavigationStack, null, 'screen'));
    expect(route.orientation).toBeUndefined();
    navigate('/spray-led-fullscreen');
    expect(route.orientation).toBe('all');
    navigate('/boards');
    expect(route.orientation).toBeUndefined();
  });
  it('locks an iPhone to portrait', () => {
    route.platformOS = 'ios';
    route.width = 393;
    route.height = 852;
    render(createElement(RootNavigationStack, null, 'screen'));
    expect(route.orientation).toBe('portrait');
  });
  it('leaves an iPad free to rotate', () => {
    route.platformOS = 'ios';
    route.isPad = true;
    route.width = 834;
    route.height = 1194;
    render(createElement(RootNavigationStack, null, 'screen'));
    expect(route.orientation).toBeUndefined();
  });
  it("follows a foldable from its outer display to its inner one, and keeps fullscreen at 'all'", () => {
    route.platformOS = 'ios';
    route.width = 393;
    route.height = 852;
    render(createElement(RootNavigationStack, null, 'screen'));
    expect(route.orientation).toBe('portrait');
    route.width = 1000;
    route.height = 780;
    navigate('/climbs');
    expect(route.orientation).toBeUndefined();
    navigate('/spray-led-fullscreen');
    expect(route.orientation).toBe('all');
    route.width = 780;
    route.height = 1000;
    navigate('/climbs');
    expect(route.orientation).toBeUndefined();
    route.width = 393;
    route.height = 852;
    navigate('/boards');
    expect(route.orientation).toBe('portrait');
  });
});
