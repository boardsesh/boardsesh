import { eq } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { boardLayouts, boardProducts, boardLayoutAliases, type NewBoardLayoutAlias } from '@boardsesh/db/schema';

type DrizzleDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

const KILTER = 'kilter';

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Resolves a Kilter Grips `productLayoutUuid` (small int-string, e.g. "27")
 * to the integer `board_layouts.id` that board_* keys on. Grips ships finer
 * layout granularity than the legacy catalog (six "Kilter Board Original"
 * variants → the single board_layouts row id=1), so the mapping is by product
 * name: if a product has exactly one board_layouts row, every Grips layout for
 * that product maps to it. Products with multiple board layouts (only Tycho
 * today) or products board_* has never seen (e.g. "UP Board") resolve to null
 * and the caller skips + reports them.
 *
 * Resolutions are persisted to `board_layout_aliases` so they survive restarts
 * and the per-user paths can reuse them. Build once per sync; `resolve` is sync
 * (all DB work is front-loaded).
 */
export type LayoutResolver = {
  resolve(productLayoutUuid: string, productName: string): number | null;
  /** New (uuid → layoutId) mappings discovered this run, to persist. */
  drainNewAliases(): NewBoardLayoutAlias[];
  /** Layouts that couldn't be mapped, for the run report. */
  unmapped(): Array<{ productLayoutUuid: string; productName: string }>;
};

export async function buildLayoutResolver(db: DrizzleDb): Promise<LayoutResolver> {
  const [layoutRows, productRows, aliasRows] = await Promise.all([
    db
      .select({ id: boardLayouts.id, productId: boardLayouts.productId })
      .from(boardLayouts)
      .where(eq(boardLayouts.boardType, KILTER)),
    db
      .select({ id: boardProducts.id, name: boardProducts.name })
      .from(boardProducts)
      .where(eq(boardProducts.boardType, KILTER)),
    db
      .select({ layoutUuid: boardLayoutAliases.layoutUuid, layoutId: boardLayoutAliases.layoutId })
      .from(boardLayoutAliases)
      .where(eq(boardLayoutAliases.boardType, KILTER)),
  ]);

  const productNameById = new Map<number, string>();
  for (const product of productRows) productNameById.set(product.id, product.name ?? '');

  const layoutsByProductName = new Map<string, number[]>();
  for (const layout of layoutRows) {
    const productName = layout.productId != null ? (productNameById.get(layout.productId) ?? '') : '';
    const key = normalizeName(productName);
    const list = layoutsByProductName.get(key) ?? [];
    list.push(layout.id);
    layoutsByProductName.set(key, list);
  }

  const persisted = new Map<string, number>();
  for (const alias of aliasRows) persisted.set(alias.layoutUuid, alias.layoutId);

  const cache = new Map<string, number | null>();
  const newAliases = new Map<string, NewBoardLayoutAlias>();
  const unmappedMap = new Map<string, string>();

  function resolve(productLayoutUuid: string, productName: string): number | null {
    const cached = cache.get(productLayoutUuid);
    if (cached !== undefined) return cached;

    const persistedId = persisted.get(productLayoutUuid);
    if (persistedId !== undefined) {
      cache.set(productLayoutUuid, persistedId);
      return persistedId;
    }

    const candidates = layoutsByProductName.get(normalizeName(productName)) ?? [];
    if (candidates.length === 1) {
      const layoutId = candidates[0];
      cache.set(productLayoutUuid, layoutId);
      newAliases.set(productLayoutUuid, {
        boardType: KILTER,
        layoutUuid: productLayoutUuid,
        layoutId,
        source: 'single-layout',
      });
      return layoutId;
    }

    // 0 candidates (product board_* never had) or >1 (ambiguous, e.g. Tycho's
    // two layouts with no per-climb signal to disambiguate) → unmapped.
    cache.set(productLayoutUuid, null);
    unmappedMap.set(productLayoutUuid, productName);
    return null;
  }

  return {
    resolve,
    drainNewAliases: () => [...newAliases.values()],
    unmapped: () =>
      [...unmappedMap.entries()].map(([productLayoutUuid, productName]) => ({ productLayoutUuid, productName })),
  };
}
