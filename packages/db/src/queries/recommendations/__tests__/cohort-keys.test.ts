import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cohortKey, cohortKeysForBoard, variantSlugFromKey, PUBLIC_RECOMMENDATION_VARIANTS } from '../cohort-keys';

void describe('cohort keys', () => {
  void it('builds the deterministic generated_recommendation key', () => {
    assert.equal(cohortKey('kilter', 8, 25, 40, 'crowd-favorites'), 'kilter:8:25:40:crowd-favorites');
  });

  void it('returns one key per public variant in display order', () => {
    assert.deepEqual(cohortKeysForBoard('tension', 9, 1, 40), [
      'tension:9:1:40:crowd-favorites',
      'tension:9:1:40:hidden-gems',
      'tension:9:1:40:fresh',
    ]);
  });

  void it('extracts the trailing slug from a key', () => {
    assert.equal(variantSlugFromKey('kilter:1:10:40:hidden-gems'), 'hidden-gems');
    assert.equal(variantSlugFromKey(null), '');
    assert.equal(variantSlugFromKey(undefined), '');
  });

  void it('round-trips every public variant slug through the key', () => {
    for (const variant of PUBLIC_RECOMMENDATION_VARIANTS) {
      assert.equal(variantSlugFromKey(cohortKey('kilter', 8, 25, 40, variant.slug)), variant.slug);
    }
  });

  void it('exposes exactly the three public cohort variants', () => {
    assert.deepEqual(
      PUBLIC_RECOMMENDATION_VARIANTS.map((variant) => variant.slug),
      ['crowd-favorites', 'hidden-gems', 'fresh'],
    );
  });
});
