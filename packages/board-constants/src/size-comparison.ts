/**
 * Board-size "fullness" scoring for the recommendation engine.
 *
 * A climb's `compatible_size_ids` lists every board size whose edge box encloses
 * it (geometric containment within one coordinate frame). We use this to score
 * how fully a climb uses the user's biggest board: a climb that also fits a
 * shorter size uses less of the wall's height; one that only fits a
 * same-height-but-narrower size keeps full height but less width. Height is the
 * dominant axis (a 10x10 owner loses no height on a 7x10 climb, so those rank
 * just below full-width; a 10x12 owner ranks kickboard-using climbs highest).
 */
import { PRODUCT_SIZES } from './product-sizes';
import type { BoardName, ProductSizeData } from './types';

const sizeHeight = (size: ProductSizeData): number => size.edgeTop - size.edgeBottom;
const sizeWidth = (size: ProductSizeData): number => size.edgeRight - size.edgeLeft;

export type SizeFullnessTiers = {
  /** Same-product sizes whose usable height is LESS than the target. */
  shorterSizeIds: number[];
  /** Same-product sizes with the SAME height but narrower than the target. */
  narrowerSameHeightSizeIds: number[];
};

/**
 * The smaller sibling sizes used to score fullness for a target board size.
 * Scoped to the same `productId` so we never compare across coordinate frames
 * (home vs commercial walls use different origins). Cross-frame ids could never
 * appear in a single climb's `compatible_size_ids` anyway, but scoping keeps the
 * injected SQL arrays tight.
 */
export function getSizeFullnessTiers(boardName: BoardName, targetSizeId: number): SizeFullnessTiers {
  const sizes = PRODUCT_SIZES[boardName];
  const target = sizes?.[targetSizeId];
  if (!target) return { shorterSizeIds: [], narrowerSameHeightSizeIds: [] };

  const targetHeight = sizeHeight(target);
  const targetWidth = sizeWidth(target);
  const shorterSizeIds: number[] = [];
  const narrowerSameHeightSizeIds: number[] = [];

  for (const size of Object.values(sizes)) {
    if (size.id === target.id || size.productId !== target.productId) continue;
    const height = sizeHeight(size);
    if (height < targetHeight) {
      shorterSizeIds.push(size.id);
    } else if (height === targetHeight && sizeWidth(size) < targetWidth) {
      narrowerSameHeightSizeIds.push(size.id);
    }
  }

  return {
    shorterSizeIds: shorterSizeIds.sort((left, right) => left - right),
    narrowerSameHeightSizeIds: narrowerSameHeightSizeIds.sort((left, right) => left - right),
  };
}

export const FULLNESS_FULL = 1.0;
export const FULLNESS_NARROWER = 0.6;
export const FULLNESS_SHORTER = 0.3;

/**
 * Fullness factor for a single climb given its `compatible_size_ids` and the
 * target size's tiers. Mirrors the SQL CASE used in the recommendation query so
 * both paths agree (and so the factor is unit-testable without a database).
 */
export function fullnessFactor(compatibleSizeIds: readonly number[], tiers: SizeFullnessTiers): number {
  const compatible = new Set(compatibleSizeIds);
  if (tiers.shorterSizeIds.some((id) => compatible.has(id))) return FULLNESS_SHORTER;
  if (tiers.narrowerSameHeightSizeIds.some((id) => compatible.has(id))) return FULLNESS_NARROWER;
  return FULLNESS_FULL;
}
