import { describe, expect, it } from 'vitest';
import { UI_VARIANT_KEY, isUiVariantPreference } from '../ui-variant';

describe('ui-variant', () => {
  it('exposes a stable storage key', () => {
    expect(UI_VARIANT_KEY).toBe('ui_variant');
  });

  it("uses only characters that satisfy expo-secure-store's regex", () => {
    // SecureStore rejects keys outside [\w.-]+ — see theme.ts.
    expect(UI_VARIANT_KEY).toMatch(/^[\w.-]+$/);
  });

  it('accepts the three valid preferences', () => {
    expect(isUiVariantPreference('auto')).toBe(true);
    expect(isUiVariantPreference('liquidGlass')).toBe(true);
    expect(isUiVariantPreference('material')).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isUiVariantPreference('Auto')).toBe(false);
    expect(isUiVariantPreference('glass')).toBe(false);
    expect(isUiVariantPreference('')).toBe(false);
    expect(isUiVariantPreference(null)).toBe(false);
    expect(isUiVariantPreference(undefined)).toBe(false);
    expect(isUiVariantPreference(0)).toBe(false);
  });
});
