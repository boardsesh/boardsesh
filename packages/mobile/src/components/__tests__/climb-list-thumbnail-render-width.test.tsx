// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ pixelRatio: 2, renderWidths: [] as Array<{ width: number; prefetch: boolean }> }));
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
  PixelRatio: { get: () => native.pixelRatio },
}));
vi.mock('../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: { fill: '#ddd' } }) }));
vi.mock('../../theme/tokens', () => ({ borderRadius: { md: 12 } }));
vi.mock('../../lib/board-render/warm-board-art-memory', () => ({
  isBoardArtInMemory: () => true,
  warmBoardArtMemory: vi.fn(),
}));
vi.mock('../../hooks/use-native-climb-render', () => ({
  useNativeClimbRender: ({ renderWidth, prefetch }: { renderWidth: number; prefetch?: boolean }) => {
    native.renderWidths.push({ width: renderWidth, prefetch: prefetch ?? false });
    return {
      overlayUri: 'file:///overlay.png',
      overlayLoadKey: '1:0',
      backgroundPaths: [],
      artworkIdentity: null,
      getReadyBoardArtSnapshot: vi.fn(),
    };
  },
}));
vi.mock('../LayeredClimbImage', () => ({ LayeredClimbImage: () => null }));

import { ClimbListThumbnail, ClimbListThumbnailPrewarm } from '../ClimbListThumbnail';
import { ClimbListThumbnailSizeContext, climbListThumbnailSize } from '../climb-list-thumbnail-metrics';

const scope = { frames: 'p1r12', boardName: 'kilter' as const, layoutId: 1, sizeId: 2, setIds: '3' };

function renderBoth(columns: 1 | 2) {
  render(
    createElement(
      ClimbListThumbnailSizeContext.Provider,
      { value: climbListThumbnailSize(columns) },
      createElement(ClimbListThumbnail, scope),
      createElement(ClimbListThumbnailPrewarm, scope),
    ),
  );
  const shown = native.renderWidths.find((entry) => !entry.prefetch);
  const warmed = native.renderWidths.find((entry) => entry.prefetch);
  return { shown: shown?.width, warmed: warmed?.width };
}

describe('list thumbnail and its prewarm ask for the same overlay', () => {
  beforeEach(() => {
    native.renderWidths.length = 0;
  });

  it('in two columns on an iPad (88pt at 2×): both 400', () => {
    native.pixelRatio = 2;
    expect(renderBoth(2)).toEqual({ shown: 400, warmed: 400 });
  });

  it('in one column on a phone (76pt at 3×): both 400', () => {
    native.pixelRatio = 3;
    expect(renderBoth(1)).toEqual({ shown: 400, warmed: 400 });
  });

  it('a caller-sized cell keeps its own 5× width', () => {
    native.pixelRatio = 3;
    render(createElement(ClimbListThumbnail, { ...scope, size: { width: 84, height: 104 } }));
    expect(native.renderWidths.at(-1)?.width).toBe(420);
  });
});
