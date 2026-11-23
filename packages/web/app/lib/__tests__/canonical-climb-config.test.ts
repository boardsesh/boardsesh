import { describe, expect, it } from 'vite-plus/test';
import { resolveCanonicalClimbConfig } from '../canonical-climb-config';

describe('resolveCanonicalClimbConfig', () => {
  it('skips a default size the climb cannot fit', () => {
    expect(resolveCanonicalClimbConfig('kilter', 1, { compatibleSizeIds: [28], requiredSetIds: [1, 20] })).toEqual({
      layoutId: 1,
      sizeId: 28,
      setIds: [1, 20],
    });
  });

  it('requires every hold set on the selected size', () => {
    expect(resolveCanonicalClimbConfig('kilter', 8, { compatibleSizeIds: [18, 17], requiredSetIds: [27] })).toEqual({
      layoutId: 8,
      sizeId: 17,
      setIds: [26, 27],
    });
  });

  it('keeps Homewall and Original in their own layouts', () => {
    const compatibleSizeIds = [7, 17, 28];
    expect(resolveCanonicalClimbConfig('kilter', 1, { compatibleSizeIds, requiredSetIds: [1] })?.sizeId).toBe(7);
    expect(resolveCanonicalClimbConfig('kilter', 8, { compatibleSizeIds, requiredSetIds: [26] })?.sizeId).toBe(17);
    expect(
      resolveCanonicalClimbConfig('kilter', 8, { compatibleSizeIds: [7, 28], requiredSetIds: [] }),
    ).toBeUndefined();
  });

  it('leaves the requested configuration in place when compatibility is unknown', () => {
    expect(resolveCanonicalClimbConfig('kilter', 1, { compatibleSizeIds: [28], requiredSetIds: null })).toBeUndefined();
    expect(resolveCanonicalClimbConfig('kilter', 1, { compatibleSizeIds: [], requiredSetIds: [1] })).toBeUndefined();
  });

  it('excludes Woods and spray walls from catalogue consolidation', () => {
    const compatibility = { compatibleSizeIds: [1, 2], requiredSetIds: [1] };
    expect(resolveCanonicalClimbConfig('woods', 1, compatibility)).toBeUndefined();
    expect(resolveCanonicalClimbConfig('spray', 1, compatibility)).toBeUndefined();
  });
});
