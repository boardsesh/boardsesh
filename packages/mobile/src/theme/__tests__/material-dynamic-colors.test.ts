import { describe, expect, it, vi } from 'vitest';
import type { Material3Scheme } from '@pchmn/expo-material3-theme';

vi.mock('react-native', () => ({ Platform: { OS: 'android' }, PlatformColor: (name: string) => name }));

import {
  brandColors,
  brandColorsDark,
  brandColorsFromDynamicPalette,
  materialSurfacesFromDynamicPalette,
} from '../colors';

const dynamicLightPalette = {
  primary: '#3366AA',
  onPrimary: '#FFFFFF',
  background: '#FBF8FF',
  onSurface: '#191C20',
  onSurfaceVariant: '#42474E',
  outlineVariant: '#C2C7CF',
  surfaceContainerLow: '#F5F2FA',
  surfaceContainer: '#EFECF4',
  elevation: { level2: '#ECEFF8' },
} as unknown as Material3Scheme;

describe('dynamic Material surfaces', () => {
  it('maps an MD3 dynamic light palette into the app systemColors shape', () => {
    const surfaces = materialSurfacesFromDynamicPalette('light', dynamicLightPalette);

    expect(surfaces.background).toBe('#FBF8FF');
    expect(surfaces.secondaryBackground).toBe('#F5F2FA');
    expect(surfaces.tertiaryBackground).toBe('#EFECF4');
    expect(surfaces.elevatedSurface).toBe('#ECEFF8');
    expect(surfaces.label).toBe('#191C20');
    expect(surfaces.secondaryLabel).toBe('#42474E');
    expect(surfaces.tertiaryLabel).toBe('rgba(25, 28, 32, 0.38)');
    expect(surfaces.separator).toBe('#C2C7CF');
    expect(surfaces.fill).toBe('rgba(51, 102, 170, 0.12)');
  });

  it('uses a stronger primary fill in dark mode', () => {
    const surfaces = materialSurfacesFromDynamicPalette('dark', dynamicLightPalette);

    expect(surfaces.fill).toBe('rgba(51, 102, 170, 0.18)');
  });

  it('keeps status colours static while switching Material accent colours', () => {
    const resolvedBrandColors = brandColorsFromDynamicPalette('light', dynamicLightPalette);

    expect(resolvedBrandColors.primary).toBe('#3366AA');
    expect(resolvedBrandColors.tint).toBe('#3366AA');
    expect(resolvedBrandColors.primaryFill).toBe('#3366AA');
    expect(resolvedBrandColors.onPrimary).toBe('#FFFFFF');
    expect(resolvedBrandColors.success).toBe(brandColors.success);
    expect(resolvedBrandColors.warning).toBe(brandColors.warning);
    expect(resolvedBrandColors.error).toBe(brandColors.error);
  });

  it('returns the scheme-aware static brand map when no dynamic palette is active', () => {
    expect(brandColorsFromDynamicPalette('light')).toBe(brandColors);
    expect(brandColorsFromDynamicPalette('dark')).toBe(brandColorsDark);
  });
});
