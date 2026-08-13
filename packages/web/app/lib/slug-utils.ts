import { dbz } from '@/app/lib/db/db';
import type { BoardName, LayoutId, Size } from '@/app/lib/types';
import { matchSetNameToSlugParts } from './slug-matching';
import { generateSlugFromText, generateDescriptionSlug, generateLayoutSlug } from './url-utils';
import { resolveSizeSlugToId } from '@boardsesh/play-view/readable-url-utils';
import { UNIFIED_TABLES } from '@/app/lib/db/queries/util/table-select';
import { eq, and, isNull } from 'drizzle-orm';
import { getAllLayouts, getSetsForLayoutAndSize, getSizesForLayoutId } from './board-constants';

// Re-export for backwards compatibility
export { matchSetNameToSlugParts } from './slug-matching';

export type LayoutRow = {
  id: number;
  name: string;
};

export type SizeRow = {
  id: number;
  name: string;
  description: string;
};

export type SetRow = {
  id: number;
  name: string;
};

function findLayoutBySlug(rows: LayoutRow[], slug: string): LayoutRow | null {
  const normalizedSlug = slug
    .toLowerCase()
    .replace(/^(kilter|tension|decoy|touchstone|grasshopper|moonboard|soill)-/, '');

  return (
    rows.find(
      (layout) =>
        layout.name && (generateLayoutSlug(layout.name) === slug || generateLayoutSlug(layout.name) === normalizedSlug),
    ) ?? null
  );
}

function findSizeBySlug(rows: SizeRow[], slug: string): SizeRow | null {
  const dimensionMatch = slug.match(/^(\d+x\d+)(?:-(.+))?$/i);

  if (dimensionMatch) {
    const dimensions = dimensionMatch[1].toLowerCase();
    const descSuffix = dimensionMatch[2];

    const size = rows.find((s) => {
      if (!s.name) return false;
      const sizeMatch = s.name.match(/(\d+)\s*x\s*(\d+)/i);
      if (!sizeMatch) return false;

      const sizeDimensions = `${sizeMatch[1]}x${sizeMatch[2]}`.toLowerCase();
      if (sizeDimensions !== dimensions) return false;

      if (descSuffix && s.description) {
        const descSlug = generateDescriptionSlug(s.description);
        return descSlug === descSuffix;
      }

      if (!descSuffix) {
        const descLower = (s.description || '').toLowerCase();
        return descLower.includes('full ride') || !s.description;
      }

      return false;
    });

    if (size) {
      return size;
    }

    if (!descSuffix) {
      return (
        rows.find((s) => {
          if (!s.name) return false;
          const sizeMatch = s.name.match(/(\d+)\s*x\s*(\d+)/i);
          if (!sizeMatch) return false;
          const sizeDimensions = `${sizeMatch[1]}x${sizeMatch[2]}`.toLowerCase();
          return sizeDimensions === dimensions;
        }) ?? null
      );
    }
  }

  return (
    rows.find((s) => {
      if (!s.name) return false;

      let sizeSlug = generateSlugFromText(s.name);

      if (s.description && s.description.trim()) {
        const descSlug = generateDescriptionSlug(s.description);

        if (descSlug) {
          sizeSlug = `${sizeSlug}-${descSlug}`;
        }
      }

      return sizeSlug === slug;
    }) ?? null
  );
}

function findSetsBySlug(rows: SetRow[], slug: string): SetRow[] {
  const slugParts = slug.split('_');
  return rows.filter((set) => matchSetNameToSlugParts(set.name, slugParts));
}

// Reverse lookup functions for slug to ID conversion
export const getLayoutBySlug = async (board_name: BoardName, slug: string): Promise<LayoutRow | null> => {
  const staticLayout = findLayoutBySlug(
    getAllLayouts(board_name).map((layout) => ({ id: layout.id, name: layout.name })),
    slug,
  );
  if (staticLayout) {
    return staticLayout;
  }

  const { layouts } = UNIFIED_TABLES;

  const rows = await dbz
    .select({ id: layouts.id, name: layouts.name })
    .from(layouts)
    .where(and(eq(layouts.boardType, board_name), eq(layouts.isListed, true), isNull(layouts.password)));

  const layout = findLayoutBySlug(
    rows.filter((row): row is LayoutRow => row.name !== null),
    slug,
  );

  return layout;
};

export const getSizeBySlug = async (
  board_name: BoardName,
  layout_id: LayoutId,
  slug: string,
): Promise<SizeRow | null> => {
  const sizesOnLayout = getSizesForLayoutId(board_name, layout_id);

  // Two sizes on one layout can share a base slug (Kilter "12 x 12 with/without
  // kickboard", both `12x12-square`), which used to leave the second one with no
  // reachable URL. `resolveSizeSlugToId` is the shared resolver the Expo app
  // uses: it keeps the bare slug pointing at the size every existing link
  // already meant and understands the qualified form for the other. Checked
  // first so a qualified slug can't be swallowed by findSizeBySlug's looser
  // dimension matching.
  const qualifiedSizeId = resolveSizeSlugToId(board_name, layout_id, slug);
  const qualifiedSize = sizesOnLayout.find((size) => size.id === qualifiedSizeId);
  if (qualifiedSize) {
    return { id: qualifiedSize.id, name: qualifiedSize.name, description: qualifiedSize.description };
  }

  const staticSize = findSizeBySlug(
    sizesOnLayout.map((size) => ({
      id: size.id,
      name: size.name,
      description: size.description,
    })),
    slug,
  );
  if (staticSize) {
    return staticSize;
  }

  const { productSizes, layouts } = UNIFIED_TABLES;

  const rows = await dbz
    .select({
      id: productSizes.id,
      name: productSizes.name,
      description: productSizes.description,
    })
    .from(productSizes)
    .innerJoin(
      layouts,
      and(eq(productSizes.boardType, layouts.boardType), eq(productSizes.productId, layouts.productId)),
    )
    .where(and(eq(layouts.boardType, board_name), eq(layouts.id, layout_id)));

  const size = findSizeBySlug(
    rows
      .filter((row): row is typeof row & { name: string } => row.name !== null)
      .map((row) => ({ id: row.id, name: row.name, description: row.description || '' })),
    slug,
  );

  return size;
};

/**
 * Parses a combined set slug and returns matching sets from the database.
 *
 * @param board_name - The board type (kilter, tension, etc.)
 * @param layout_id - The layout ID
 * @param size_id - The size ID
 * @param slug - The combined slug (e.g., 'main-kicker_main_aux-kicker_aux')
 * @returns Array of matching sets
 */
export const getSetsBySlug = async (
  board_name: BoardName,
  layout_id: LayoutId,
  size_id: Size,
  slug: string,
): Promise<SetRow[]> => {
  const staticSets = findSetsBySlug(
    getSetsForLayoutAndSize(board_name, layout_id, size_id).map((set) => ({
      id: set.id,
      name: set.name,
    })),
    slug,
  );
  if (staticSets.length > 0) {
    return staticSets;
  }

  const { sets, productSizesLayoutsSets } = UNIFIED_TABLES;

  const rows = await dbz
    .select({ id: sets.id, name: sets.name })
    .from(sets)
    .innerJoin(
      productSizesLayoutsSets,
      and(eq(sets.boardType, productSizesLayoutsSets.boardType), eq(sets.id, productSizesLayoutsSets.setId)),
    )
    .where(
      and(
        eq(productSizesLayoutsSets.boardType, board_name),
        eq(productSizesLayoutsSets.productSizeId, size_id),
        eq(productSizesLayoutsSets.layoutId, layout_id),
      ),
    );

  const matchingSets = findSetsBySlug(
    rows
      .filter((row): row is typeof row & { name: string } => row.name !== null)
      .map((row) => ({ id: row.id, name: row.name })),
    slug,
  );

  return matchingSets;
};
