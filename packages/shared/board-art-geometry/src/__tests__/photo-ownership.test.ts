import { describe, expect, it } from 'vitest';
import { placementsWithoutOwnPhotoBody, cutPhotoContactSeams } from '../segmentation/photo-ownership';

describe('photographic placement ownership', () => {
  it('cuts only the measured source seam, joining existing ground', () => {
    const mask = new Uint8Array(20 * 20);
    for (let y = 5; y <= 15; y += 1) for (let x = 5; x <= 15; x += 1) mask[y * 20 + x] = 1;
    cutPhotoContactSeams(mask, 20, 20, [
      [
        [10, 4],
        [10, 16],
      ],
    ]);
    expect(mask[9 * 20 + 10]).toBe(0);
    expect(mask[9 * 20 + 9]).toBe(1);
    expect(mask[9 * 20 + 11]).toBe(1);
    expect(mask[0]).toBe(0);
  });
  it('does not let an outside logical slot claim a body with its own center', () => {
    const mask = new Uint8Array(40 * 24);
    for (let y = 6; y <= 18; y += 1) {
      for (let x = 12; x <= 25; x += 1) mask[y * 40 + x] = 1;
    }
    for (let y = 2; y <= 7; y += 1) {
      for (let x = 2; x <= 8; x += 1) mask[y * 40 + x] = 1;
    }
    const withoutOwnBody = placementsWithoutOwnPhotoBody(mask, 40, 24, [
      { id: 1, cx: 18, cy: 12, r: 8 },
      { id: 2, cx: 27, cy: 15, r: 8 },
      // A misregistered standalone hold still has its own entire body.
      { id: 3, cx: 1, cy: 3, r: 8 },
      // Two centers inside substance do not establish an alias or an empty slot.
      { id: 4, cx: 20, cy: 12, r: 8 },
    ]);
    expect([...withoutOwnBody]).toEqual([2]);
  });
});
