import { describe, it, expect } from 'vitest';
import { ALLOWED_IMAGE_SIZES, BETA_THUMBNAIL_REQUEST_SIZE, snapToAllowedImageSize } from '../image-sizes';

describe('snapToAllowedImageSize', () => {
  it('returns the smallest bucket that covers the target', () => {
    expect(snapToAllowedImageSize(40)).toBe(44);
    expect(snapToAllowedImageSize(44)).toBe(44);
    expect(snapToAllowedImageSize(120)).toBe(128);
    expect(snapToAllowedImageSize(141)).toBe(280);
  });

  it('clamps to the largest bucket when the target exceeds the allowlist', () => {
    expect(snapToAllowedImageSize(99999)).toBe(280);
  });

  it('only ever returns an allowlisted size', () => {
    for (let target = 1; target <= 320; target += 7) {
      expect(ALLOWED_IMAGE_SIZES as readonly number[]).toContain(snapToAllowedImageSize(target));
    }
  });
});

describe('BETA_THUMBNAIL_REQUEST_SIZE', () => {
  it('is a member of the allowlist (so the backend honors it)', () => {
    expect(ALLOWED_IMAGE_SIZES as readonly number[]).toContain(BETA_THUMBNAIL_REQUEST_SIZE);
  });
});
