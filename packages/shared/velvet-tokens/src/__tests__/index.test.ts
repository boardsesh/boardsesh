import { describe, it, expect } from 'vitest';
import { brandColors, brandColorsDark, materialSurfaces, withAlpha, blendOpaque } from '../index';

describe('brand palette anchors', () => {
  it('holds the load-bearing Velvet values per scheme', () => {
    // Foreground vs fill diverge in dark; these are the values the whole web split rests on.
    expect(brandColors.primary).toBe('#6D28D9');
    expect(brandColors.primaryFill).toBe('#6D28D9');
    expect(brandColors.accent).toBe('#FF8A3D');
    expect(brandColors.onPrimary).toBe('#FFFFFF');
    expect(brandColorsDark.primary).toBe('#A78BFA'); // lifted foreground
    expect(brandColorsDark.primaryFill).toBe('#7C3AED'); // fill stays dark for white text
  });

  it('exposes the surface anchors web reads', () => {
    expect(materialSurfaces.light.background).toBe('#F3EFFA');
    expect(materialSurfaces.dark.background).toBe('#15101E');
    expect(materialSurfaces.light.label).toBe('#16111F');
    expect(materialSurfaces.dark.label).toBe('#F5F2FB');
  });
});

describe('withAlpha', () => {
  it('converts a 6-digit hex to rgba', () => {
    expect(withAlpha('#6D28D9', 0.5)).toBe('rgba(109, 40, 217, 0.5)');
  });

  it('expands a 3-digit hex before converting', () => {
    expect(withAlpha('#abc', 1)).toBe('rgba(170, 187, 204, 1)');
  });

  it('passes non-hex input through unchanged (already rgba / named / PlatformColor)', () => {
    expect(withAlpha('rgba(0, 0, 0, 0.3)', 0.5)).toBe('rgba(0, 0, 0, 0.3)');
    expect(withAlpha('red', 0.5)).toBe('red');
  });
});

describe('blendOpaque', () => {
  it('returns the foreground when fully opaque', () => {
    expect(blendOpaque('#ffffff', '#000000', 1)).toBe('#ffffff');
  });

  it('returns the background when fully transparent', () => {
    expect(blendOpaque('#ffffff', '#000000', 0)).toBe('#000000');
  });

  it('composites to an opaque midpoint', () => {
    expect(blendOpaque('#ffffff', '#000000', 0.5)).toBe('#808080');
  });

  it('passes through when either input is not hex', () => {
    expect(blendOpaque('rgba(0,0,0,0.5)', '#ffffff', 0.5)).toBe('#ffffff');
  });

  it('clamps out-of-range alpha so it never emits an invalid hex', () => {
    expect(blendOpaque('#ffffff', '#000000', 2)).toBe('#ffffff'); // clamps to 1
    expect(blendOpaque('#ffffff', '#000000', -1)).toBe('#000000'); // clamps to 0
  });
});
