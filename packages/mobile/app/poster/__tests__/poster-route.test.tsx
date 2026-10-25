// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const route = vi.hoisted(() => ({
  params: {} as Record<string, string | string[]>,
  launchReady: true,
}));
const router = vi.hoisted(() => ({ replace: vi.fn() }));
const browser = vi.hoisted(() => ({ open: vi.fn(async () => {}) }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => route.params,
  useRouter: () => router,
}));
vi.mock('../../../src/components/ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('div', { 'data-testid': 'spinner' }),
}));
vi.mock('../../../src/lib/launch-hold', () => ({ useLaunchHoldReleased: () => route.launchReady }));
vi.mock('../../../src/lib/open-url', () => ({ openExternalUrl: browser.open }));
vi.mock('../../../src/lib/env', () => ({ WEB_BASE_URL: 'https://www.boardsesh.com' }));

const { default: PosterLinkRoute } = await import('../[...rest]');

const WALL_UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';

beforeEach(() => {
  vi.clearAllMocks();
  route.params = { rest: ['b', 'the-garage'], wall: WALL_UUID };
  route.launchReady = true;
});

describe('poster link fallback route', () => {
  it('reopens the same poster page in the in-app browser and puts Home underneath', () => {
    render(createElement(PosterLinkRoute));

    expect(browser.open).toHaveBeenCalledTimes(1);
    expect(browser.open).toHaveBeenCalledWith(
      `https://www.boardsesh.com/poster/b/the-garage?wall=${WALL_UUID}`,
      'poster-link-fallback',
    );
    expect(router.replace).toHaveBeenCalledWith('/(tabs)/home');
    // Android presents the browser unreliably once a replace has started.
    expect(browser.open.mock.invocationCallOrder[0]).toBeLessThan(router.replace.mock.invocationCallOrder[0]);
  });

  it('opens the poster root when the link names no page', () => {
    route.params = {};
    render(createElement(PosterLinkRoute));

    expect(browser.open).toHaveBeenCalledWith('https://www.boardsesh.com/poster', 'poster-link-fallback');
    expect(router.replace).toHaveBeenCalledWith('/(tabs)/home');
  });

  it('opens once across re-renders', () => {
    const { rerender } = render(createElement(PosterLinkRoute));
    rerender(createElement(PosterLinkRoute));

    expect(browser.open).toHaveBeenCalledTimes(1);
  });

  // A cold-start update could reload the app under the browser (#6006).
  it('waits for the launch hold before it opens anything', () => {
    route.launchReady = false;
    const { rerender, getByTestId } = render(createElement(PosterLinkRoute));

    expect(getByTestId('spinner')).toBeTruthy();
    expect(browser.open).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();

    route.launchReady = true;
    rerender(createElement(PosterLinkRoute));
    expect(browser.open).toHaveBeenCalledTimes(1);
  });
});
