import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client';
import * as dbSchema from '@boardsesh/db/schema';

export type AuroraCatalogConfigFixture = {
  boardType: string;
  productId: number;
  layoutId: number;
  sizeId: number;
  setIds: number[];
  associationIdBase: number;
  isListed?: boolean;
};

type CatalogKey = { boardType: string; id: number };

/**
 * Install the smallest real relational catalog needed by resolver integration
 * tests. Only rows actually inserted by this call are removed, so the helper
 * neither overwrites nor deletes catalog data another fixture already owns.
 */
export async function seedAuroraCatalogFixtures(configs: AuroraCatalogConfigFixture[]): Promise<() => Promise<void>> {
  const insertedProducts: CatalogKey[] = [];
  const insertedLayouts: CatalogKey[] = [];
  const insertedSizes: CatalogKey[] = [];
  const insertedSets: CatalogKey[] = [];
  const insertedAssociations: CatalogKey[] = [];

  for (const config of configs) {
    const [insertedProduct] = await db
      .insert(dbSchema.boardProducts)
      .values({
        boardType: config.boardType,
        id: config.productId,
        name: 'Catalog validation test product',
        isListed: config.isListed ?? true,
      })
      .onConflictDoNothing()
      .returning({ boardType: dbSchema.boardProducts.boardType, id: dbSchema.boardProducts.id });
    if (insertedProduct) insertedProducts.push(insertedProduct);

    const [insertedLayout] = await db
      .insert(dbSchema.boardLayouts)
      .values({
        boardType: config.boardType,
        id: config.layoutId,
        productId: config.productId,
        name: 'Catalog validation test layout',
        isListed: config.isListed ?? true,
      })
      .onConflictDoNothing()
      .returning({ boardType: dbSchema.boardLayouts.boardType, id: dbSchema.boardLayouts.id });
    if (insertedLayout) insertedLayouts.push(insertedLayout);

    const [insertedSize] = await db
      .insert(dbSchema.boardProductSizes)
      .values({
        boardType: config.boardType,
        id: config.sizeId,
        productId: config.productId,
        name: 'Catalog validation test size',
        isListed: config.isListed ?? true,
      })
      .onConflictDoNothing()
      .returning({ boardType: dbSchema.boardProductSizes.boardType, id: dbSchema.boardProductSizes.id });
    if (insertedSize) insertedSizes.push(insertedSize);

    for (const setId of config.setIds) {
      const [insertedSet] = await db
        .insert(dbSchema.boardSets)
        .values({ boardType: config.boardType, id: setId, name: `Catalog validation test set ${setId}` })
        .onConflictDoNothing()
        .returning({ boardType: dbSchema.boardSets.boardType, id: dbSchema.boardSets.id });
      if (insertedSet) insertedSets.push(insertedSet);
    }

    for (const [setIndex, setId] of config.setIds.entries()) {
      const [insertedAssociation] = await db
        .insert(dbSchema.boardProductSizesLayoutsSets)
        .values({
          boardType: config.boardType,
          id: config.associationIdBase + setIndex,
          productSizeId: config.sizeId,
          layoutId: config.layoutId,
          setId,
          isListed: config.isListed ?? true,
        })
        .onConflictDoNothing()
        .returning({
          boardType: dbSchema.boardProductSizesLayoutsSets.boardType,
          id: dbSchema.boardProductSizesLayoutsSets.id,
        });
      if (insertedAssociation) insertedAssociations.push(insertedAssociation);
    }
  }

  return async () => {
    for (const { boardType, id } of insertedAssociations.reverse()) {
      await db
        .delete(dbSchema.boardProductSizesLayoutsSets)
        .where(
          and(
            eq(dbSchema.boardProductSizesLayoutsSets.boardType, boardType),
            eq(dbSchema.boardProductSizesLayoutsSets.id, id),
          ),
        );
    }
    for (const { boardType, id } of insertedSets.reverse()) {
      await db
        .delete(dbSchema.boardSets)
        .where(and(eq(dbSchema.boardSets.boardType, boardType), eq(dbSchema.boardSets.id, id)));
    }
    for (const { boardType, id } of insertedSizes.reverse()) {
      await db
        .delete(dbSchema.boardProductSizes)
        .where(and(eq(dbSchema.boardProductSizes.boardType, boardType), eq(dbSchema.boardProductSizes.id, id)));
    }
    for (const { boardType, id } of insertedLayouts.reverse()) {
      await db
        .delete(dbSchema.boardLayouts)
        .where(and(eq(dbSchema.boardLayouts.boardType, boardType), eq(dbSchema.boardLayouts.id, id)));
    }
    for (const { boardType, id } of insertedProducts.reverse()) {
      await db
        .delete(dbSchema.boardProducts)
        .where(and(eq(dbSchema.boardProducts.boardType, boardType), eq(dbSchema.boardProducts.id, id)));
    }
  };
}
