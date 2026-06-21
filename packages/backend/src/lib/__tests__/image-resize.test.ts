import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { ALLOWED_IMAGE_SIZES, parseSizeParam, resizeImageBuffer, resizedVariantKey } from '../image-resize';

describe('parseSizeParam', () => {
  it('accepts every allowlisted size', () => {
    for (const size of ALLOWED_IMAGE_SIZES) {
      expect(parseSizeParam(String(size))).toBe(size);
    }
  });

  it('rejects values outside the allowlist (caller serves the original)', () => {
    expect(parseSizeParam('100')).toBeNull();
    expect(parseSizeParam('1000')).toBeNull();
    expect(parseSizeParam('0')).toBeNull();
  });

  it('rejects junk and missing values', () => {
    expect(parseSizeParam(null)).toBeNull();
    expect(parseSizeParam(undefined)).toBeNull();
    expect(parseSizeParam('')).toBeNull();
    expect(parseSizeParam('abc')).toBeNull();
    expect(parseSizeParam('140px')).toBeNull();
    expect(parseSizeParam('-140')).toBeNull();
  });
});

describe('resizedVariantKey', () => {
  it('appends an @<size>.jpg suffix to the base key', () => {
    expect(resizedVariantKey('avatars/u1.jpg', 140)).toBe('avatars/u1.jpg@140.jpg');
    expect(resizedVariantKey('beta-link-thumbnails/instagram/abc.jpg', 280)).toBe(
      'beta-link-thumbnails/instagram/abc.jpg@280.jpg',
    );
  });

  it('is distinct per size so variants never collide', () => {
    expect(resizedVariantKey('avatars/u1.jpg', 64)).not.toBe(resizedVariantKey('avatars/u1.jpg', 140));
  });
});

describe('resizeImageBuffer', () => {
  it('resizes a larger source down to the requested square as JPEG', async () => {
    const source = await sharp({
      create: { width: 1000, height: 1000, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .png()
      .toBuffer();

    const resized = await resizeImageBuffer(source, 140);
    const meta = await sharp(resized).metadata();

    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(140);
    expect(meta.height).toBe(140);
  });

  it('does not upscale a source smaller than the requested size', async () => {
    const source = await sharp({
      create: { width: 60, height: 60, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();

    const resized = await resizeImageBuffer(source, 280);
    const meta = await sharp(resized).metadata();

    // withoutEnlargement keeps the 60px source at 60px rather than blowing
    // it up to 280px.
    expect(meta.width).toBe(60);
    expect(meta.height).toBe(60);
  });
});
