import { describe, expect, it } from 'vitest';
import { brandColors, brandColorsDark } from '@boardsesh/velvet-tokens';
import {
  brandAccentColor,
  brandControlTint,
  composeSeedColor,
  filterChipBorders,
  filterChipBrandColors,
  sliderControlColors,
  switchControlColors,
  radioControlColors,
  textFieldBrandColors,
  textInputBrandColors,
  tonalButtonColors,
} from '../expo-ui-modifiers';

const DARK_M3 = {
  outline: '#817b8d',
  surfaceVariant: '#1d132f',
  onSurfaceVariant: '#A9A2B6',
  secondaryContainer: 'rgba(124, 58, 237, 0.28)',
  onSecondaryContainer: '#EADDFF',
};
const LIGHT_M3 = {
  outline: '#96949a',
  surfaceVariant: '#e8dff7',
  onSurfaceVariant: '#5B5563',
  secondaryContainer: 'rgba(109, 40, 217, 0.16)',
  onSecondaryContainer: '#21005D',
};

describe('brand control colours', () => {
  it('tints controls with the foreground violet and keeps the fill for white-text surfaces', () => {
    expect(brandControlTint(brandColorsDark)).toBe('#A78BFA');
    expect(brandAccentColor(brandColorsDark)).toBe('#7C3AED');
    expect(brandControlTint(brandColors)).toBe('#6D28D9');
  });

  it('gives the dark-mode Android Switch a dark checked thumb on the lighter track', () => {
    expect(switchControlColors(brandColorsDark, DARK_M3, 'dark')).toEqual({
      checkedTrackColor: '#A78BFA',
      checkedThumbColor: '#16111F',
      uncheckedTrackColor: '#1d132f',
      uncheckedThumbColor: '#817b8d',
      uncheckedBorderColor: '#817b8d',
    });
  });

  it('gives the light-mode Android Switch a white checked thumb and the Velvet off state', () => {
    expect(switchControlColors(brandColors, LIGHT_M3, 'light')).toEqual({
      checkedTrackColor: '#6D28D9',
      checkedThumbColor: '#FFFFFF',
      uncheckedTrackColor: '#e8dff7',
      uncheckedThumbColor: '#96949a',
      uncheckedBorderColor: '#96949a',
    });
  });

  it('seeds every Compose Host from the brand fill', () => {
    expect(composeSeedColor(brandColorsDark)).toBe('#7C3AED');
    expect(composeSeedColor(brandColors)).toBe('#6D28D9');
  });

  it('fills the tonal button from Velvet, not the seeded Compose default', () => {
    expect(tonalButtonColors(DARK_M3)).toEqual({
      containerColor: 'rgba(124, 58, 237, 0.28)',
      contentColor: '#EADDFF',
    });
  });

  it('names the filter chip label, icon and fill states and borders only the idle chip', () => {
    expect(filterChipBrandColors(brandColorsDark, DARK_M3)).toEqual({
      labelColor: '#A9A2B6',
      iconColor: '#A78BFA',
      selectedContainerColor: '#7C3AED',
      selectedLabelColor: '#FFFFFF',
      selectedLeadingIconColor: '#FFFFFF',
    });
    expect(filterChipBorders(DARK_M3)).toEqual({
      idle: { width: 1, color: '#817b8d' },
      selected: { width: 0, color: 'transparent' },
    });
  });

  it('dots the selected radio in the control tint and rings the empty one in onSurfaceVariant', () => {
    expect(radioControlColors(brandColorsDark, DARK_M3)).toEqual({
      selectedColor: '#A78BFA',
      unselectedColor: '#A9A2B6',
    });
  });

  it('fills the Android Slider with the control tint', () => {
    expect(sliderControlColors(brandColorsDark)).toEqual({ thumbColor: '#A78BFA', activeTrackColor: '#A78BFA' });
  });
});

describe('text input brand colours', () => {
  it('gives Android an opaque caret and handles with a translucent highlight', () => {
    expect(textInputBrandColors(brandColorsDark, 'android')).toEqual({
      cursorColor: '#A78BFA',
      selectionHandleColor: '#A78BFA',
      selectionColor: 'rgba(167, 139, 250, 0.4)',
    });
  });

  it('gives iOS only an opaque selection tint', () => {
    expect(textInputBrandColors(brandColorsDark, 'ios')).toEqual({ selectionColor: '#A78BFA' });
  });

  it('draws the Compose caret in the foreground tint', () => {
    expect(textFieldBrandColors(brandColorsDark).cursorColor).toBe('#A78BFA');
  });
});
