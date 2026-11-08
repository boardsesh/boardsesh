import { describe, expect, it } from 'vitest';
import { brandColors, brandColorsDark } from '@boardsesh/velvet-tokens';
import {
  brandAccentColor,
  brandControlTint,
  composeSeedColor,
  composeSurfaceColorOverrides,
  filterChipBorders,
  filterChipBrandColors,
  sliderControlColors,
  switchControlColors,
  radioControlColors,
  textFieldBrandColors,
  textInputBrandColors,
  toComposeRgbaHex,
  tonalButtonColors,
} from '../expo-ui-modifiers';

const DARK_M3 = {
  outline: '#8A8A8A',
  surfaceVariant: '#1A1A1A',
  onSurfaceVariant: '#B0B0B0',
  secondaryContainer: '#3C2467',
  onSecondaryContainer: '#EADDFF',
};
const LIGHT_M3 = {
  outline: '#7A7A7A',
  surfaceVariant: '#E4E4E4',
  onSurfaceVariant: '#5A5A5A',
  secondaryContainer: '#E6DAF8',
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
      uncheckedTrackColor: '#1A1A1A',
      uncheckedThumbColor: '#8A8A8A',
      uncheckedBorderColor: '#8A8A8A',
    });
  });

  it('gives the light-mode Android Switch a white checked thumb and the Velvet off state', () => {
    expect(switchControlColors(brandColors, LIGHT_M3, 'light')).toEqual({
      checkedTrackColor: '#6D28D9',
      checkedThumbColor: '#FFFFFF',
      uncheckedTrackColor: '#E4E4E4',
      uncheckedThumbColor: '#7A7A7A',
      uncheckedBorderColor: '#7A7A7A',
    });
  });

  it('seeds every Compose Host from the brand fill', () => {
    expect(composeSeedColor(brandColorsDark)).toBe('#7C3AED');
    expect(composeSeedColor(brandColors)).toBe('#6D28D9');
  });

  it('fills the tonal button from Velvet, not the seeded Compose default', () => {
    expect(tonalButtonColors(DARK_M3)).toEqual({
      containerColor: '#3C2467',
      contentColor: '#EADDFF',
    });
  });

  it('names the filter chip label, icon and fill states and borders only the idle chip', () => {
    expect(filterChipBrandColors(brandColorsDark, DARK_M3)).toEqual({
      labelColor: '#B0B0B0',
      iconColor: '#A78BFA',
      selectedContainerColor: '#7C3AED',
      selectedLabelColor: '#FFFFFF',
      selectedLeadingIconColor: '#FFFFFF',
    });
    expect(filterChipBorders(DARK_M3)).toEqual({
      idle: { width: 1, color: '#8A8A8A' },
      selected: { width: 0, color: 'transparent' },
    });
  });

  it('dots the selected radio in the control tint and rings the empty one in onSurfaceVariant', () => {
    expect(radioControlColors(brandColorsDark, DARK_M3)).toEqual({
      selectedColor: '#A78BFA',
      unselectedColor: '#B0B0B0',
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

describe('toComposeRgbaHex', () => {
  it('turns every theme colour form into #RRGGBBAA, keeping its alpha', () => {
    expect(toComposeRgbaHex('#1e1e1e')).toBe('#1E1E1EFF');
    expect(toComposeRgbaHex('#abc')).toBe('#AABBCCFF');
    expect(toComposeRgbaHex('#11223380')).toBe('#11223380');
    expect(toComposeRgbaHex('rgba(0, 0, 0, 0.12)')).toBe('#0000001F');
    expect(toComposeRgbaHex('rgb(255, 255, 255)')).toBe('#FFFFFFFF');
  });

  it('gives up on anything else, so the role keeps its seeded value', () => {
    expect(toComposeRgbaHex('transparent')).toBeNull();
    expect(toComposeRgbaHex('systemFill')).toBeNull();
  });
});

describe('composeSurfaceColorOverrides', () => {
  const LIGHT_SURFACES = {
    background: '#F2F2F2',
    onBackground: '#1A1A1A',
    surface: '#FFFFFF',
    onSurface: '#1A1A1A',
    surfaceVariant: '#E4E4E4',
    onSurfaceVariant: '#5A5A5A',
    outline: '#7A7A7A',
    outlineVariant: 'rgba(0, 0, 0, 0.12)',
  };
  const LIGHT_CONTAINERS = {
    lowest: '#EEEEEE',
    low: '#EAEAEA',
    base: '#E4E4E4',
    high: '#DFDFDF',
    level4: '#DCDCDC',
    highest: '#D9D9D9',
  };

  it('maps the light ladder: dim is the darkest container, bright the white card', () => {
    expect(composeSurfaceColorOverrides(LIGHT_SURFACES, LIGHT_CONTAINERS, 'light')).toEqual({
      background: '#F2F2F2FF',
      onBackground: '#1A1A1AFF',
      surface: '#FFFFFFFF',
      surfaceDim: '#D9D9D9FF',
      surfaceBright: '#FFFFFFFF',
      surfaceContainerLowest: '#EEEEEEFF',
      surfaceContainerLow: '#EAEAEAFF',
      surfaceContainer: '#E4E4E4FF',
      surfaceContainerHigh: '#DFDFDFFF',
      surfaceContainerHighest: '#D9D9D9FF',
      surfaceVariant: '#E4E4E4FF',
      onSurface: '#1A1A1AFF',
      onSurfaceVariant: '#5A5A5AFF',
      outline: '#7A7A7AFF',
      outlineVariant: '#0000001F',
      surfaceTint: '#FFFFFFFF',
    });
  });

  it('lifts the dark menu and dialog containers above the card', () => {
    const darkSurfaces = {
      ...LIGHT_SURFACES,
      background: '#0E0E0E',
      surface: '#1E1E1E',
      onSurface: '#EDEDED',
      onBackground: '#EDEDED',
    };
    const darkContainers = {
      lowest: '#121212',
      low: '#161616',
      base: '#1A1A1A',
      high: '#262626',
      level4: '#2A2A2A',
      highest: '#2E2E2E',
    };
    const overrides = composeSurfaceColorOverrides(darkSurfaces, darkContainers, 'dark');
    expect(overrides.surfaceContainerLow).toBe('#1E1E1EFF');
    expect(overrides.surfaceContainer).toBe('#262626FF');
    expect(overrides.surfaceContainerHigh).toBe('#2A2A2AFF');
    expect(overrides.surfaceContainerHighest).toBe('#2E2E2EFF');
  });

  it('leaves out a role whose theme value it cannot convert', () => {
    const overrides = composeSurfaceColorOverrides(
      { ...LIGHT_SURFACES, outline: 'systemGray' },
      LIGHT_CONTAINERS,
      'light',
    );
    expect(overrides).not.toHaveProperty('outline');
    expect(overrides.surface).toBe('#FFFFFFFF');
  });
});
