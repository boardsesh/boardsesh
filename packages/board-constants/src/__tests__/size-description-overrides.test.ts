// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import { describe, expect, it } from 'vite-plus/test';
import { AURORA_PRODUCT_SIZES } from '../generated/product-sizes-data';
import { normalizeSizeDescription } from '../size-description-overrides';

describe('normalizeSizeDescription', () => {
  it("corrects Aurora's 'Commerical' typo", () => {
    expect(normalizeSizeDescription('Commerical')).toBe('Commercial');
  });

  it('passes an uncorrected description through unchanged', () => {
    expect(normalizeSizeDescription('Home')).toBe('Home');
    expect(normalizeSizeDescription('')).toBe('');
  });
});

describe('generated Aurora product-size descriptions', () => {
  it("spells the Kilter 12 x 14 size 'Commercial'", () => {
    // Also the board URL segment: `generateSizeSlug` folds the description into
    // the size slug, so this string is `12x14-commercial` in every board link.
    expect(AURORA_PRODUCT_SIZES.kilter[7].description).toBe('Commercial');
  });

  // The point of the layering: the correction lives in the generator, and the
  // generated file is committed. This fixed point is what ties the two together
  // — a regeneration that somehow bypassed the map would reintroduce the typo
  // silently, and this fails CI instead.
  it('is a fixed point of the correction map', () => {
    for (const [boardName, sizesById] of Object.entries(AURORA_PRODUCT_SIZES)) {
      for (const size of Object.values(sizesById)) {
        expect(
          normalizeSizeDescription(size.description),
          `${boardName} size ${size.id} ("${size.name}") has an uncorrected description`,
        ).toBe(size.description);
      }
    }
  });
});
