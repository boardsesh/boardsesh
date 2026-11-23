import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import React from 'react';
import PlaylistCoverMosaic from '../playlist-cover-mosaic';

/**
 * The playlist cover: up to four climbs' board art, laid out so no cell is
 * ever empty, and the icon tile when there is no art to draw.
 */

const layerProps = vi.fn();
vi.mock('../../board-renderer/board-image-layers', () => ({
  default: (props: Record<string, unknown>) => {
    layerProps(props);
    return <div data-testid="board-image-layers" />;
  },
}));

const climb = (uuid: string, overrides: Record<string, unknown> = {}) => ({
  uuid,
  frames: 'p1r12',
  mirrored: false,
  boardType: 'kilter',
  layoutId: 1,
  ...overrides,
});

const fallback = <div data-testid="cover-fallback" />;

function renderCover(climbs: ReturnType<typeof climb>[]) {
  return render(<PlaylistCoverMosaic climbs={climbs} fallbackBoardType="kilter" fallback={fallback} />);
}

const shapes = () => screen.queryAllByTestId('playlist-cover-cell').map((cell) => cell.getAttribute('data-shape'));

beforeEach(() => {
  layerProps.mockClear();
});

describe('PlaylistCoverMosaic', () => {
  it('keeps the icon tile for an empty playlist', () => {
    renderCover([]);
    expect(screen.getByTestId('cover-fallback')).toBeTruthy();
    expect(screen.queryByTestId('playlist-cover-mosaic')).toBeNull();
  });

  it('keeps the icon tile when no climb has board art to draw', () => {
    renderCover([climb('spray-1', { boardType: 'spray' })]);
    expect(screen.getByTestId('cover-fallback')).toBeTruthy();
  });

  it('lets one climb fill the whole tile, at full resolution', () => {
    renderCover([climb('a')]);
    expect(shapes()).toEqual(['full']);
    expect(layerProps).toHaveBeenCalledTimes(1);
    expect(layerProps.mock.calls[0][0]).toMatchObject({ frames: 'p1r12', thumbnail: false, fetchPriority: 'high' });
    expect(screen.queryByTestId('cover-fallback')).toBeNull();
  });

  it('splits two climbs into tall halves on the rows’ thumbnails', () => {
    renderCover([climb('a'), climb('b')]);
    expect(shapes()).toEqual(['tall', 'tall']);
    expect(layerProps.mock.calls.map(([props]) => props.thumbnail)).toEqual([true, true]);
  });

  it('puts the first of three climbs in a tall half beside two squares', () => {
    renderCover([climb('a'), climb('b'), climb('c')]);
    expect(shapes()).toEqual(['tall', 'square', 'square']);
  });

  it('draws the first four climbs as a 2×2 and only the first loads eagerly', () => {
    renderCover([climb('a'), climb('b'), climb('c'), climb('d'), climb('e')]);
    expect(shapes()).toEqual(['square', 'square', 'square', 'square']);
    expect(layerProps.mock.calls.map(([props]) => props.fetchPriority)).toEqual([
      'high',
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('skips a climb without art and fills its place from the next one', () => {
    renderCover([climb('a'), climb('spray-1', { boardType: 'spray' }), climb('b')]);
    expect(shapes()).toEqual(['tall', 'tall']);
  });

  it('hides the cover from assistive tech: every climb is a named row below it', () => {
    renderCover([climb('a')]);
    expect(screen.getByTestId('playlist-cover-mosaic').getAttribute('aria-hidden')).toBe('true');
  });
});
