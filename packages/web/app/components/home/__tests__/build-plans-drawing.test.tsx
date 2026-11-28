import { describe, expect, it } from 'vite-plus/test';
import { render } from '@testing-library/react';
import React from 'react';
import { getHolePlacements, getProductSize } from '@boardsesh/board-constants/product-sizes';
import BuildPlansDrawing, {
  AUXILIARY_HOLES,
  DIMENSION_FIGURES,
  HOMEWALL_EDGES,
  MAINLINE_HOLES,
} from '../build-plans-drawing';

// The homepage drawing claims to be a 7×10 Kilter Homewall. These pin that
// claim to the catalogue, so a drawing that stops matching the real wall fails
// here instead of shipping as a pretty pattern.
const HOMEWALL_LAYOUT_ID = 8;
const HOMEWALL_7X10_SIZE_ID = 17;
const MAINLINE_SET_ID = 26;
const AUXILIARY_SET_ID = 27;

function holesInside(setId: number) {
  const edges = getProductSize('kilter', HOMEWALL_7X10_SIZE_ID);
  if (!edges) throw new Error('Kilter Homewall 7×10 is missing from the catalogue');
  return getHolePlacements('kilter', HOMEWALL_LAYOUT_ID, setId)
    .filter(([, , x, y]) => x > edges.edgeLeft && x < edges.edgeRight && y > edges.edgeBottom && y < edges.edgeTop)
    .map(([, , x, y]) => `${x}:${y}`)
    .sort();
}

const asKeys = (holes: ReadonlyArray<{ x: number; y: number }>) => holes.map(({ x, y }) => `${x}:${y}`).sort();

describe('BuildPlansDrawing', () => {
  it('draws the 7×10 Homewall edges', () => {
    const size = getProductSize('kilter', HOMEWALL_7X10_SIZE_ID);
    expect(size?.name).toBe('7x10');
    expect(size).toMatchObject({
      edgeLeft: HOMEWALL_EDGES.left,
      edgeRight: HOMEWALL_EDGES.right,
      edgeBottom: HOMEWALL_EDGES.bottom,
      edgeTop: HOMEWALL_EDGES.top,
    });
  });

  it('draws exactly the mainline and auxiliary holes of that wall', () => {
    expect(asKeys(MAINLINE_HOLES)).toEqual(holesInside(MAINLINE_SET_ID));
    expect(asKeys(AUXILIARY_HOLES)).toEqual(holesInside(AUXILIARY_SET_ID));
  });

  it('puts every hole on exactly one panel and takes its name from the caption', () => {
    const { getByTestId } = render(
      <figure>
        <BuildPlansDrawing labelledBy="caption" />
        <figcaption id="caption">The hole grid</figcaption>
      </figure>,
    );
    const svg = getByTestId('build-plans-drawing');
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-labelledby')).toBe('caption');
    expect(svg.querySelectorAll('circle')).toHaveLength(MAINLINE_HOLES.length + AUXILIARY_HOLES.length);
    expect(svg.querySelectorAll('[data-panel]')).toHaveLength(3);
  });

  it('prints only the locale-neutral feet figures, matching the 88" × 120" wall', () => {
    const { getByTestId } = render(<BuildPlansDrawing labelledBy="caption" />);
    const texts = [...getByTestId('build-plans-drawing').querySelectorAll('text')].map((text) => text.textContent);
    expect(texts.sort()).toEqual([DIMENSION_FIGURES.height, DIMENSION_FIGURES.width].sort());
    // Aurora's 7×10 is 88" × 120" between edges: 7′ 4" and 10′, named in whole feet.
    expect(Math.floor((HOMEWALL_EDGES.right - HOMEWALL_EDGES.left) / 12)).toBe(7);
    expect((HOMEWALL_EDGES.top - HOMEWALL_EDGES.bottom) / 12).toBe(10);
    expect(DIMENSION_FIGURES).toEqual({ width: '7′', height: '10′' });
  });
});
