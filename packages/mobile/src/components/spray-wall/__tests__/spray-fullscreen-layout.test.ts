import { describe, expect, it } from 'vitest';
import { shouldUseSprayPhotoRail } from '../spray-fullscreen-layout';
describe('photo editor control placement', () => {
  it.each([
    [400, 800, 800, 1200, true],
    [800, 400, 1200, 800, true],
    [1100, 600, 800, 1200, false],
    [400, 800, 1200, 800, false],
    [800, 400, 800, 1200, true],
    [0, 0, 800, 1200, false],
  ])('chooses rail for box %s×%s and photo %s×%s', (width, height, photoWidth, photoHeight, expected) => {
    expect(shouldUseSprayPhotoRail(width, height, photoWidth, photoHeight)).toBe(expected);
  });
});
