import { describe, expect, it } from 'vitest';
import { resolveGorhomDynamicSizing } from '../bottom-sheet-props';

describe('resolveGorhomDynamicSizing', () => {
  it('disables Gorhom dynamic sizing when Expo-style snap points are provided', () => {
    expect(resolveGorhomDynamicSizing(['60%', '92%'], undefined)).toBe(false);
    expect(resolveGorhomDynamicSizing(['60%'], true)).toBe(false);
  });

  it('preserves Expo dynamic sizing when no snap points are provided', () => {
    expect(resolveGorhomDynamicSizing(undefined, undefined)).toBe(true);
    expect(resolveGorhomDynamicSizing(undefined, true)).toBe(true);
    expect(resolveGorhomDynamicSizing(undefined, false)).toBe(false);
  });
});
