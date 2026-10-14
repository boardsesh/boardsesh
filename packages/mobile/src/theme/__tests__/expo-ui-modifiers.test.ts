import { describe, expect, it } from 'vitest';
import { brandColors, brandColorsDark } from '@boardsesh/velvet-tokens';
import { brandAccentColor, brandControlTint, sliderControlColors, switchControlColors } from '../expo-ui-modifiers';

describe('brand control colours', () => {
  it('tints controls with the foreground violet and keeps the fill for white-text surfaces', () => {
    expect(brandControlTint(brandColorsDark)).toBe('#A78BFA');
    expect(brandAccentColor(brandColorsDark)).toBe('#7C3AED');
    expect(brandControlTint(brandColors)).toBe('#6D28D9');
  });

  it('gives the dark-mode Android Switch a dark checked thumb on the lighter track', () => {
    expect(switchControlColors(brandColorsDark, 'dark')).toEqual({
      checkedTrackColor: '#A78BFA',
      checkedThumbColor: '#16111F',
    });
  });

  it('leaves the light-mode Android Switch thumb at the Compose default', () => {
    expect(switchControlColors(brandColors, 'light')).toEqual({ checkedTrackColor: '#6D28D9' });
  });

  it('fills the Android Slider with the control tint', () => {
    expect(sliderControlColors(brandColorsDark)).toEqual({ thumbColor: '#A78BFA', activeTrackColor: '#A78BFA' });
  });
});
