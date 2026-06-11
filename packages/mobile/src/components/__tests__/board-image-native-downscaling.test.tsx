// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type ViewProps = { children?: ReactNode };
vi.mock('react-native', () => ({
  View: ({ children }: ViewProps) => createElement('div', null, children),
}));

vi.mock('../../hooks/use-native-climb-render', () => ({
  useNativeClimbRender: () => ({
    overlayUri: 'file:///overlay.png',
    backgroundPaths: ['/background.webp'],
    missingBackgroundCount: 0,
  }),
}));

type LayeredClimbImageProps = { allowDownscaling?: boolean };
vi.mock('../LayeredClimbImage', () => ({
  LayeredClimbImage: ({ allowDownscaling }: LayeredClimbImageProps) =>
    createElement('div', {
      'data-testid': 'layered-climb-image',
      'data-allow-downscaling': String(allowDownscaling),
    }),
}));

import { BoardImageNative } from '../BoardImageNative';

const baseProps = {
  frames: 'p1145r15',
  boardName: 'kilter' as const,
  layoutId: 1,
  sizeId: 10,
  setIds: '1,20',
  boardWidth: 1080,
  boardHeight: 1920,
};

describe('BoardImageNative downscaling policy', () => {
  it('allows downscaling for full-size play-view renders', () => {
    const { getByTestId } = render(createElement(BoardImageNative, baseProps));

    expect(getByTestId('layered-climb-image').getAttribute('data-allow-downscaling')).toBe('true');
  });

  it('disables downscaling when callers request a pre-sized renderWidth', () => {
    const { getByTestId } = render(createElement(BoardImageNative, { ...baseProps, renderWidth: 400 }));

    expect(getByTestId('layered-climb-image').getAttribute('data-allow-downscaling')).toBe('false');
  });
});
