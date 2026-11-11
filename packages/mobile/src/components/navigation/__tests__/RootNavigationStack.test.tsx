// @vitest-environment jsdom
import { createElement, memo, useSyncExternalStore, type ReactNode } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const route = vi.hoisted(() => ({
  pathname: '/boards',
  listeners: new Set<() => void>(),
  orientation: undefined as string | undefined,
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
  Stack: ({ screenOptions, children }: { screenOptions: { orientation?: string }; children: ReactNode }) => {
    route.orientation = screenOptions.orientation;
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
    route.width = 800;
    route.height = 400;
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
