import { describe, it, expect } from 'vite-plus/test';
import { brandCtaSx, brandCtaOutlinedSx, type BrandCtaSize } from '../brand-cta';

/**
 * These two recipes exist because the same pill was hand-written at nine call
 * sites and drifted. The drift was never in the colours — it was in the SIZE:
 * the filled store button took `px: 4` while the outlined one beside it took
 * `px: 3` and a smaller font, so a pair that was meant to read as one control
 * pair rendered mismatched.
 *
 * So the invariant worth pinning is not "the object has these keys" (that just
 * restates the source) but "a filled and an outlined button asked for the same
 * size step come out the same size". That is the thing a future edit can break
 * without noticing.
 */
const SIZES: BrandCtaSize[] = ['small', 'medium', 'large'];
const SIZE_KEYS = ['px', 'py', 'fontSize', 'minHeight'] as const;

type SizeShape = Partial<Record<(typeof SIZE_KEYS)[number], unknown>>;

function sizeShapeOf(recipe: Record<string, unknown>): SizeShape {
  const shape: SizeShape = {};
  for (const key of SIZE_KEYS) {
    if (key in recipe) shape[key] = recipe[key];
  }
  return shape;
}

describe('the brand CTA pair shares one size ramp', () => {
  it.each(SIZES)('filled and outlined agree on every size dimension at %s', (size) => {
    const filled = sizeShapeOf(brandCtaSx({ size }));
    const outlined = sizeShapeOf(brandCtaOutlinedSx({ size }));

    expect(outlined).toEqual(filled);
  });

  it('floors the medium step at the 44px target MUI would otherwise leave at 40', () => {
    // MUI's sizeMedium is 40px. The site holds itself to 44, and the ramp is the
    // one place that can say so for both recipes at once.
    expect(brandCtaSx({ size: 'medium' })).toHaveProperty('minHeight', 44);
    expect(brandCtaOutlinedSx({ size: 'medium' })).toHaveProperty('minHeight', 44);
  });

  it('gives both recipes the same pill radius and un-shouted label', () => {
    for (const recipe of [brandCtaSx(), brandCtaOutlinedSx()]) {
      expect(recipe.borderRadius).toBe('9999px');
      expect(recipe.textTransform).toBe('none');
    }
  });
});

describe('the outlined recipe reads the control-boundary token', () => {
  it('draws its edge with --control-border, never the decorative --separator', () => {
    // An outlined button has no fill, so its border IS the affordance. `--separator`
    // composites to ~1.5:1 on our surfaces and fails WCAG 1.4.11; `--control-border`
    // is the opaque >= 3:1 token added for exactly this role.
    const outlined = brandCtaOutlinedSx();

    expect(outlined.borderColor).toBe('var(--control-border)');
    expect(JSON.stringify(outlined)).not.toContain('--separator');
  });

  it('uses the FOREGROUND violet for its label, not the fill violet', () => {
    // #A78BFA on the page; #7C3AED is the filled-surface violet and would be
    // 2.5:1 as text. The filled recipe is the one that may touch the fill.
    expect(brandCtaOutlinedSx().color).toBe('var(--color-primary)');
    expect(brandCtaSx().backgroundColor).toBe('var(--color-primary-fill)');
  });

  it('carries no glow, because the amber spark belongs to the filled pill', () => {
    const outlined = brandCtaOutlinedSx() as Record<string, unknown>;

    expect(outlined).not.toHaveProperty('boxShadow');
    expect(JSON.stringify(outlined)).not.toContain('accent-glow');
  });

  it('cancels the global hover lift the way the filled pill does', () => {
    // StartClimbingButton's shared override translates on hover; a brand pill
    // stays anchored. If one recipe cancels it and the other does not, a pair
    // wobbles apart on hover.
    for (const recipe of [brandCtaSx(), brandCtaOutlinedSx()]) {
      expect(recipe['&:hover']).toHaveProperty('transform', 'none');
    }
  });
});
