// @vitest-environment jsdom
import { createElement, memo, useSyncExternalStore, type ReactNode } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const route = vi.hoisted(() => ({
  pathname: '/boards',
  listeners: new Set<() => void>(),
  orientation: undefined as string | undefined,
  width: 400,
  height: 800,
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  Dimensions: { get: () => ({ width: route.width, height: route.height }) },
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
});
