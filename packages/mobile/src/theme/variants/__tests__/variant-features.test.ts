import { describe, it, expect } from 'vitest';
import { variantFeatures } from '../variant-features';

// Exhaustiveness across variants is enforced at COMPILE time by the
// `satisfies Record<UiVariant, VariantFeatures>` on the registry (a missing variant
// won't compile), so there's no runtime key-set assertion here — that would only
// re-check what the type system already guarantees, with a worse error message.
describe('variantFeatures', () => {
  it('suppresses the in-body large title on Material only (the M3 app bar owns it)', () => {
    expect(variantFeatures.liquidGlass.inBodyLargeTitle).toBe(true);
    expect(variantFeatures.material.inBodyLargeTitle).toBe(false);
  });

  it('routes filters into the top chrome on Material only', () => {
    expect(variantFeatures.material.filtersInTopChrome).toBe(true);
    expect(variantFeatures.liquidGlass.filtersInTopChrome).toBe(false);
  });

  it('excludes the grade filter from the Material summary only', () => {
    expect(variantFeatures.material.summaryExcludesGradeFilter).toBe(true);
    expect(variantFeatures.liquidGlass.summaryExcludesGradeFilter).toBe(false);
  });
});
