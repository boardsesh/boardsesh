import { describe, it, expect } from 'vite-plus/test';
import { brandCtaSx, brandCtaOutlinedSx, type BrandCtaSize } from '../brand-cta';

/**
 * These two recipes exist because the same button was hand-written at nine call
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

  it('gives both recipes the same 10px corner and un-shouted label', () => {
    // A rounded rectangle, not a pill: the round-ended version read as a capsule
    // next to the page's 12px cards and 10px inputs.
    for (const recipe of [brandCtaSx(), brandCtaOutlinedSx()]) {
      expect(recipe.borderRadius).toBe('10px');
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

  it('is the grey secondary action: label ink, transparent ground, no violet at rest or on hover', () => {
    // A page spends its violet on the one filled action, links and text actions.
    // The outlined pill beside the filled one is grey: #EDEDED clears 4.5:1 on every
    // surface step (the parity test pins it). Only the filled recipe touches violet.
    const outlined = brandCtaOutlinedSx();

    expect(outlined.color).toBe('var(--neutral-900)');
    expect(outlined.backgroundColor).toBe('transparent');
    expect(outlined.fontWeight).toBe(600);
    expect(outlined['&:hover']).toMatchObject({
      color: 'var(--neutral-900)',
      borderColor: 'var(--control-border)',
      backgroundColor: 'var(--semantic-button-hover)',
    });
    const { '&:focus-visible, &.Mui-focusVisible': focusRing, ...restOfRecipe } = outlined;
    expect(JSON.stringify(restOfRecipe)).not.toContain('--color-primary');
    // The focus ring is the one violet it carries, shared by every control.
    expect(focusRing).toEqual({ outline: '2px solid var(--color-primary)', outlineOffset: '2px' });
    expect(brandCtaSx().backgroundColor).toBe('var(--color-primary-fill)');
    expect(brandCtaSx()['&:hover'].backgroundColor).toBe('var(--color-primary-fill-hover)');
  });

  it('casts no glow on either button, at rest or on hover', () => {
    // The mint CTA glow went with the violet page; the filled violet alone marks
    // the page's primary action now.
    for (const recipe of [brandCtaSx({ size: 'large' }), brandCtaOutlinedSx({ size: 'large' })]) {
      expect(recipe).not.toHaveProperty('boxShadow');
      expect(recipe['&:hover']).not.toHaveProperty('boxShadow');
      expect(JSON.stringify(recipe)).not.toContain('accent-glow');
    }
  });

  it('cancels the global hover lift the way the filled pill does', () => {
    // StartClimbingButton's shared override translates on hover; a brand button
    // stays anchored. If one recipe cancels it and the other does not, a pair
    // wobbles apart on hover.
    for (const recipe of [brandCtaSx(), brandCtaOutlinedSx()]) {
      expect(recipe['&:hover']).toHaveProperty('transform', 'none');
    }
  });
});
