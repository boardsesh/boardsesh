// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nativeRender = vi.hoisted(() => ({ calls: 0 }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));

vi.mock('../../theme/tokens', () => ({ borderRadius: { md: 8 } }));

vi.mock('../../hooks/use-native-climb-render', () => ({
  useNativeClimbRender: () => {
    nativeRender.calls += 1;
    return {
      overlayUri: null,
      overlayLoadKey: null,
      onOverlayLoad: () => {},
      onOverlayError: () => {},
      backgroundPaths: [],
      missingBackgroundCount: 0,
    };
  },
}));

vi.mock('../LayeredClimbImage', () => ({
  LayeredClimbImage: () => createElement('div', { 'data-testid': 'photo-board' }),
}));

vi.mock('../quantum/QuantumBoardImage', () => ({
  QuantumBoardImage: () => createElement('div', { 'data-testid': 'quantum-board' }),
}));

import { BoardImageNative } from '../BoardImageNative';
import { ClimbListThumbnail } from '../ClimbListThumbnail';

const baseProps = {
  frames: '',
  layoutId: 9101,
  sizeId: 9201,
  setIds: '1',
  boardWidth: 1500,
  boardHeight: 1500,
};

beforeEach(() => {
  nativeRender.calls = 0;
});

afterEach(cleanup);

describe('BoardImageNative Quantum routing', () => {
  it('uses the neutral renderer without invoking the photo renderer hook', () => {
    const { getByTestId, queryByTestId } = render(
      createElement(BoardImageNative, { ...baseProps, boardName: 'quantum' }),
    );

    expect(getByTestId('quantum-board')).toBeTruthy();
    expect(queryByTestId('photo-board')).toBeNull();
    expect(nativeRender.calls).toBe(0);
  });

  it('leaves the existing photo-backed board path unchanged', () => {
    const { getByTestId, queryByTestId } = render(
      createElement(BoardImageNative, {
        ...baseProps,
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 10,
      }),
    );

    expect(getByTestId('photo-board')).toBeTruthy();
    expect(queryByTestId('quantum-board')).toBeNull();
    expect(nativeRender.calls).toBe(1);
  });
});

describe('ClimbListThumbnail Quantum routing', () => {
  it('routes Quantum to the neutral renderer without invoking the photo hook', () => {
    const { getByTestId, queryByTestId } = render(
      createElement(ClimbListThumbnail, { ...baseProps, boardName: 'quantum' }),
    );

    expect(getByTestId('quantum-board')).toBeTruthy();
    expect(queryByTestId('photo-board')).toBeNull();
    expect(nativeRender.calls).toBe(0);
  });

  it('keeps photo-backed list thumbnails on the native raster path', () => {
    const { getByTestId, queryByTestId } = render(
      createElement(ClimbListThumbnail, {
        ...baseProps,
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 10,
      }),
    );

    expect(getByTestId('photo-board')).toBeTruthy();
    expect(queryByTestId('quantum-board')).toBeNull();
    expect(nativeRender.calls).toBe(1);
  });
});
