import { describe, it, expect } from 'vitest';
import { variantFeatures } from '../variant-features';

describe('variantFeatures', () => {
  it('suppresses the in-body large title on Material only (the M3 app bar owns it)', () => {
    expect(variantFeatures.liquidGlass.inBodyLargeTitle).toBe(true);
    expect(variantFeatures.material.inBodyLargeTitle).toBe(false);
  });

  it('routes filters into the top chrome on Material only', () => {
    expect(variantFeatures.material.filtersInTopChrome).toBe(true);
    expect(variantFeatures.liquidGlass.filtersInTopChrome).toBe(false);
  });

  it('declares every variant (exhaustive map)', () => {
    expect(Object.keys(variantFeatures).sort()).toEqual(['liquidGlass', 'material']);
  });
});
