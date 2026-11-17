import { describe, expect, it } from 'vitest';
import { shouldUseSprayPhotoRail } from '../spray-fullscreen-layout';
describe('photo editor control placement', () => {
  it.each([
    [400, 800, 800, 1200, true],
    [800, 400, 1200, 800, true],
    [1100, 600, 800, 1200, true],
    [400, 800, 1200, 800, false],
    [800, 400, 800, 1200, true],
    [0, 0, 800, 1200, false],
  ])('chooses rail for box %s×%s and photo %s×%s', (width, height, photoWidth, photoHeight, expected) => {
    expect(shouldUseSprayPhotoRail(width, height, photoWidth, photoHeight)).toBe(expected);
  });

  it('switches to a rail if translated or large text no longer fits below a wide photo', () => {
    expect(shouldUseSprayPhotoRail(400, 800, 1200, 800, 180)).toBe(false);
    expect(shouldUseSprayPhotoRail(400, 800, 1200, 800, 300)).toBe(true);
  });
});
