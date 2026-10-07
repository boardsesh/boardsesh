import { describe, expect, it } from 'vitest';
import type { Quad } from '@boardsesh/spray-wall-geometry';

import { cornerQualityNote } from '../corner-quality';

const FRAME = { width: 3000, height: 4000 };

describe('cornerQualityNote', () => {
  it('says nothing before there are corners, or without a frame', () => {
    expect(cornerQualityNote(null, FRAME)).toBeNull();
    expect(
      cornerQualityNote(
        [
          [0, 0],
          [3000, 0],
          [3000, 4000],
          [0, 4000],
        ],
        null,
      ),
    ).toBeNull();
  });

  it('grades a square-on quad as good', () => {
    const quad: Quad = [
      [100, 100],
      [2900, 100],
      [2900, 3900],
      [100, 3900],
    ];
    expect(cornerQualityNote(quad, FRAME)).toBe('good');
  });

  it('grades a hard keystone as a fail', () => {
    // The top edge is a sliver of the bottom one: shot from far below and close in.
    const quad: Quad = [
      [1350, 100],
      [1650, 100],
      [2900, 3900],
      [100, 3900],
    ];
    expect(cornerQualityNote(quad, FRAME)).toBe('fail');
  });

  it('calls out a frame too small to flatten', () => {
    const quad: Quad = [
      [10, 10],
      [590, 10],
      [590, 790],
      [10, 790],
    ];
    expect(cornerQualityNote(quad, { width: 600, height: 800 })).toBe('small');
  });
});
