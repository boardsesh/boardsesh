import { eq, and, isNull } from 'drizzle-orm';
import { db } from '../../../db/client';
import { UNIFIED_TABLES, isValidBoardName, type BoardName } from '../../../db/queries/util/table-select';
import { validateInput } from '../shared/helpers';
import { BoardNameSchema } from '../../../validation/schemas';

/**
 * Generate a URL-safe slug from text.
 * Mirrors the logic from packages/web/app/lib/url-utils.ts
 */
function generateSlugFromText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function generateLayoutSlug(name: string): string {
  return generateSlugFromText(name);
}

function generateDescriptionSlug(description: string): string {
  return generateSlugFromText(description);
}

interface SlugLayout {
  id: number;
  name: string;
}

interface SlugSize {
  id: number;
  name: string;
  description: string;
}

interface SlugSet {
  id: number;
  name: string;
}

interface SlugResult {
  layout?: SlugLayout | null;
  size?: SlugSize | null;
  sets?: SlugSet[] | null;
}

/**
 * Match set names to slug parts.
 * Mirrors matchSetNameToSlugParts from packages/web/app/lib/slug-matching.ts
 */
function matchSetNameToSlugParts(name: string, slugParts: string[]): boolean {
  const nameSlug = generateSlugFromText(name);
  return slugParts.some(part => nameSlug === part || nameSlug.includes(part) || part.includes(nameSlug));
}

export const resolveSlugQuery = {
  resolveSlug: async (
    _: unknown,
    { boardName, type, slug, layoutId, sizeId }: {
      boardName: string;
      type: 'LAYOUT' | 'SIZE' | 'SETS';
      slug: string;
      layoutId?: number;
      sizeId?: number;
    },
  ): Promise<SlugResult> => {
    validateInput(BoardNameSchema, boardName, 'boardName');

    if (!isValidBoardName(boardName)) {
      throw new Error(`Invalid board name: ${boardName}`);
    }

    const boardType = boardName as BoardName;

    switch (type) {
      case 'LAYOUT': {
        const { layouts } = UNIFIED_TABLES;
        const rows = await db
          .select({ id: layouts.id, name: layouts.name })
          .from(layouts)
          .where(
            and(
              eq(layouts.boardType, boardType),
              eq(layouts.isListed, true),
              isNull(layouts.password),
            ),
          );

        const layout = rows.find(l => {
          if (!l.name) return false;
          return generateLayoutSlug(l.name) === slug;
        });

        if (!layout || !layout.name) {
          return { layout: null };
        }
        return { layout: { id: layout.id, name: layout.name } };
      }

      case 'SIZE': {
        if (layoutId === undefined || layoutId === null) {
          throw new Error('layoutId is required for SIZE slug resolution');
        }

        const { productSizes, layouts } = UNIFIED_TABLES;
        const rows = await db
          .select({
            id: productSizes.id,
            name: productSizes.name,
            description: productSizes.description,
          })
          .from(productSizes)
          .innerJoin(
            layouts,
            and(
              eq(productSizes.boardType, layouts.boardType),
              eq(productSizes.productId, layouts.productId),
            ),
          )
          .where(
            and(
              eq(layouts.boardType, boardType),
              eq(layouts.id, layoutId),
            ),
          );

        // Parse slug - may be "10x12" or "10x12-full-ride"
        const dimensionMatch = slug.match(/^(\d+x\d+)(?:-(.+))?$/i);

        if (dimensionMatch) {
          const dimensions = dimensionMatch[1].toLowerCase();
          const descSuffix = dimensionMatch[2];

          const size = rows.find(s => {
            if (!s.name) return false;
            const sizeMatch = s.name.match(/(\d+)\s*x\s*(\d+)/i);
            if (!sizeMatch) return false;
            const sizeDimensions = `${sizeMatch[1]}x${sizeMatch[2]}`.toLowerCase();
            if (sizeDimensions !== dimensions) return false;

            if (descSuffix && s.description) {
              return generateDescriptionSlug(s.description) === descSuffix;
            }
            if (!descSuffix) {
              const descLower = (s.description || '').toLowerCase();
              return descLower.includes('full ride') || !s.description;
            }
            return false;
          });

          if (size && size.name) {
            return { size: { id: size.id, name: size.name, description: size.description || '' } };
          }

          // Fallback for no suffix
          if (!descSuffix) {
            const fallbackSize = rows.find(s => {
              if (!s.name) return false;
              const sizeMatch = s.name.match(/(\d+)\s*x\s*(\d+)/i);
              if (!sizeMatch) return false;
              const sizeDimensions = `${sizeMatch[1]}x${sizeMatch[2]}`.toLowerCase();
              return sizeDimensions === dimensions;
            });
            if (fallbackSize && fallbackSize.name) {
              return { size: { id: fallbackSize.id, name: fallbackSize.name, description: fallbackSize.description || '' } };
            }
          }
        }

        // General fallback
        const size = rows.find(s => {
          if (!s.name) return false;
          let sizeSlug = generateSlugFromText(s.name);
          if (s.description && s.description.trim()) {
            const descSlug = generateDescriptionSlug(s.description);
            if (descSlug) {
              sizeSlug = `${sizeSlug}-${descSlug}`;
            }
          }
          return sizeSlug === slug;
        });

        if (!size || !size.name) {
          return { size: null };
        }
        return { size: { id: size.id, name: size.name, description: size.description || '' } };
      }

      case 'SETS': {
        if (layoutId === undefined || layoutId === null) {
          throw new Error('layoutId is required for SETS slug resolution');
        }
        if (sizeId === undefined || sizeId === null) {
          throw new Error('sizeId is required for SETS slug resolution');
        }

        const { sets } = UNIFIED_TABLES;
        const { boardProductSizesLayoutsSets } = await import('@boardsesh/db/schema');

        const rows = await db
          .select({ id: sets.id, name: sets.name })
          .from(sets)
          .innerJoin(
            boardProductSizesLayoutsSets,
            and(
              eq(sets.boardType, boardProductSizesLayoutsSets.boardType),
              eq(sets.id, boardProductSizesLayoutsSets.setId),
            ),
          )
          .where(
            and(
              eq(boardProductSizesLayoutsSets.boardType, boardType),
              eq(boardProductSizesLayoutsSets.productSizeId, sizeId),
              eq(boardProductSizesLayoutsSets.layoutId, layoutId),
            ),
          );

        const slugParts = slug.split('_');
        const matchingSets = rows
          .filter((s): s is typeof s & { name: string } =>
            s.name !== null && matchSetNameToSlugParts(s.name, slugParts),
          )
          .map(s => ({ id: s.id, name: s.name }));

        return { sets: matchingSets.length > 0 ? matchingSets : null };
      }

      default:
        throw new Error(`Unknown slug type: ${type}`);
    }
  },
};
