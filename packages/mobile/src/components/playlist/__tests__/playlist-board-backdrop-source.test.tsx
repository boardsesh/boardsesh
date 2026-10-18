// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// Which file the backdrop actually draws, end to end: the real playlist board
// config, the real render data and the real bundled-art lookup. Only the
// manifest (module ids) and the native asset loader are stand-ins. The sibling
// test mocks the lookup, so it cannot see the source change.

const appearance = vi.hoisted(() => ({ colorScheme: 'light' as 'light' | 'dark' }));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  StyleSheet: {
    create: (styles: Record<string, unknown>) => styles,
    absoluteFill: {},
  },
}));

vi.mock('expo-image', () => ({
  Image: ({ source }: { source: { uri: string } }) => createElement('img', { src: source.uri }),
}));

// A bundled asset resolves to a file named after its module id, so the test can
// read which manifest entry was drawn.
const { MockAsset } = vi.hoisted(() => {
  class HoistedMockAsset {
    localUri: string;
    constructor(moduleId: number) {
      this.localUri = `file:///bundled/${moduleId}.webp`;
    }
    async downloadAsync(): Promise<void> {}
    static fromModule(moduleId: number) {
      return new HoistedMockAsset(moduleId);
    }
  }
  return { MockAsset: HoistedMockAsset };
});
vi.mock('expo-asset', () => ({ Asset: MockAsset }));

vi.mock('../../../lib/board-backgrounds-manifest', () => ({
  BOARD_BACKGROUND_ASSETS: {
    'moonboard/thumbs/moonboard-bg.webp': 100,
    'moonboard/thumbs/moonboard-bg.dark.webp': 101,
    'moonboard/moonboard2024/thumbs/holdsetd.webp': 200,
    'moonboard/moonboard2024/thumbs/holdsete.webp': 201,
    'moonboard/moonboard2024/thumbs/holdsetf.webp': 202,
    'moonboard/moonboard2024/thumbs/woodenholds.webp': 203,
    'moonboard/moonboard2024/thumbs/woodenholdsb.webp': 204,
    'moonboard/moonboard2024/thumbs/woodenholdsc.webp': 205,
  },
}));

vi.mock('../../../providers/theme-provider', () => ({
  useAppColorScheme: () => appearance.colorScheme,
}));

import { MOONBOARD_LAYOUTS } from '@boardsesh/board-config';
import { PlaylistBoardBackdrop } from '../PlaylistBoardBackdrop';

const MOONBOARD_2024_LAYOUT_ID = MOONBOARD_LAYOUTS['moonboard-2024'].id;

afterEach(() => {
  appearance.colorScheme = 'light';
});

describe('PlaylistBoardBackdrop source on a MoonBoard', () => {
  // Issue #6234 took the A-K / 1-18 label art out of the stack. The backdrop
  // draws the first layer, which is now the first hold set: a board, not a sheet
  // of letters on nothing.
  it('draws the first hold set, not the label art', () => {
    const { container } = render(
      createElement(PlaylistBoardBackdrop, { boardType: 'moonboard', layoutId: MOONBOARD_2024_LAYOUT_ID }) as ReactNode,
    );
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/bundled/200.webp');
  });

  it('keeps the label art out in dark mode too', () => {
    appearance.colorScheme = 'dark';
    const { container } = render(
      createElement(PlaylistBoardBackdrop, { boardType: 'moonboard', layoutId: MOONBOARD_2024_LAYOUT_ID }) as ReactNode,
    );
    // Hold Set D ships no dark copy, so the light thumb serves both schemes.
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/bundled/200.webp');
  });
});
