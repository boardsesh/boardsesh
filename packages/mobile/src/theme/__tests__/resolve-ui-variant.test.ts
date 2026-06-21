import { describe, expect, it } from 'vitest';
import { resolveUiVariant } from '../resolve-ui-variant';

describe('resolveUiVariant', () => {
  it("follows the platform on 'auto': glass on iPhone, Material on Android", () => {
    // autoPrefersGlass = (Platform.OS === 'ios'), true on every iPhone including
    // iOS < 26 (which degrades to the blur surface fallback downstream).
    expect(resolveUiVariant('auto', true)).toBe('liquidGlass');
    expect(resolveUiVariant('auto', false)).toBe('material');
  });

  it('honours an explicit Liquid Glass choice on iPhone', () => {
    expect(resolveUiVariant('liquidGlass', true)).toBe('liquidGlass');
  });

  it('honours an explicit Liquid Glass choice on Android', () => {
    // Forced glass on a non-glass platform still resolves to the glass *variant*;
    // GlassSurface degrades the actual rendering to solid.
    expect(resolveUiVariant('liquidGlass', false)).toBe('liquidGlass');
  });

  it('honours an explicit Material choice on any platform', () => {
    expect(resolveUiVariant('material', true)).toBe('material');
    expect(resolveUiVariant('material', false)).toBe('material');
  });
});
