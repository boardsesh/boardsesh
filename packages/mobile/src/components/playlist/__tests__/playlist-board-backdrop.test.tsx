// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const ctrl = vi.hoisted(() => ({
  colorScheme: 'light' as 'light' | 'dark',
  tryGetBackgroundPathsSync: vi.fn(),
  ensureBackgroundsCached: vi.fn(),
}));

vi.mock('react-native', () => ({
  StyleSheet: {
    create: (styles: Record<string, unknown>) => styles,
    absoluteFill: {},
  },
}));

vi.mock('expo-image', () => ({
  Image: ({ source }: { source: { uri: string } }) => createElement('img', { src: source.uri }),
}));

vi.mock('../../../lib/playlists/board-details-for-playlist', () => ({
  getBoardConfigForPlaylist: () => ({
    boardName: 'moonboard',
    layoutId: 8,
    sizeId: 23,
    setIds: [51],
  }),
}));

vi.mock('../../../lib/background-image-cache', () => ({
  tryGetBackgroundPathsSync: ctrl.tryGetBackgroundPathsSync,
  ensureBackgroundsCached: ctrl.ensureBackgroundsCached,
}));

vi.mock('../../../providers/theme-provider', () => ({
  useAppColorScheme: () => ctrl.colorScheme,
}));

import { PlaylistBoardBackdrop } from '../PlaylistBoardBackdrop';

describe('PlaylistBoardBackdrop', () => {
  it('resolves the dark MoonBoard art when the app is in dark mode', () => {
    ctrl.colorScheme = 'dark';
    ctrl.tryGetBackgroundPathsSync.mockReturnValue({ paths: ['/bundled/moonboard.dark.webp'], missingCount: 0 });
    ctrl.ensureBackgroundsCached.mockClear();

    const { container } = render(
      createElement(PlaylistBoardBackdrop, { boardType: 'moonboard', layoutId: 8 }) as ReactNode,
    );

    expect(ctrl.tryGetBackgroundPathsSync).toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'thumb', colorScheme: 'dark' }),
    );
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/bundled/moonboard.dark.webp');
  });

  it('resolves the light MoonBoard art when the app is in light mode', () => {
    ctrl.colorScheme = 'light';
    ctrl.tryGetBackgroundPathsSync.mockReturnValue({ paths: ['/bundled/moonboard.webp'], missingCount: 0 });
    ctrl.ensureBackgroundsCached.mockClear();

    const { container } = render(
      createElement(PlaylistBoardBackdrop, { boardType: 'moonboard', layoutId: 8 }) as ReactNode,
    );

    expect(ctrl.tryGetBackgroundPathsSync).toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'thumb', colorScheme: 'light' }),
    );
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/bundled/moonboard.webp');
  });
});
