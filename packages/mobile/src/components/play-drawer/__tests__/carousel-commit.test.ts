import { describe, expect, it } from 'vitest';
import { carouselCommitDirection } from '../carousel-commit';
describe('carousel release intent', () => {
  it('commits a short fast flick in the drag direction', () => {
    expect(carouselCommitDirection(-24, -1000, 100)).toBe('next');
    expect(carouselCommitDirection(24, 1000, 100)).toBe('previous');
  });
  it('keeps taps, slow short drags, and reversal flicks on the current climb', () => {
    expect(carouselCommitDirection(2, 1800, 100)).toBeNull();
    expect(carouselCommitDirection(24, 100, 100)).toBeNull();
    expect(carouselCommitDirection(24, -1800, 100)).toBeNull();
  });
  it('still commits a deliberate long drag without velocity', () => {
    expect(carouselCommitDirection(-101, 0, 100)).toBe('next');
  });
});
