import { describe, expect, it } from 'vitest';
import { boardLayouts, boardProducts, boardLayoutAliases } from '@boardsesh/db/schema';

import { buildLayoutResolver } from './layout-resolver';

type Rows = Record<string, unknown>[];

// Minimal Drizzle shim: select(...).from(table).where(...) resolves to the
// seeded rows for that table. buildLayoutResolver issues exactly three reads.
function mockDb(seed: { layouts: Rows; products: Rows; aliases: Rows }) {
  const db = {
    select() {
      return {
        from(table: unknown) {
          const rows =
            table === boardLayouts
              ? seed.layouts
              : table === boardProducts
                ? seed.products
                : table === boardLayoutAliases
                  ? seed.aliases
                  : [];
          return { where: () => Promise.resolve(rows) };
        },
      };
    },
  };
  return db as unknown as Parameters<typeof buildLayoutResolver>[0];
}

const PRODUCTS: Rows = [
  { id: 1, name: 'Kilter Board Original' },
  { id: 7, name: 'Kilter Board Homewall' },
  { id: 6, name: 'Tycho' },
];
const LAYOUTS: Rows = [
  { id: 1, productId: 1 },
  { id: 8, productId: 7 },
  { id: 6, productId: 6 }, // Tycho Complete
  { id: 7, productId: 6 }, // Tycho 2020 — makes Tycho ambiguous
];

void describe('buildLayoutResolver', () => {
  it('maps a single-layout product (many Grips variants → one board layout)', async () => {
    const resolver = await buildLayoutResolver(mockDb({ layouts: LAYOUTS, products: PRODUCTS, aliases: [] }));
    expect(resolver.resolve('27', 'Kilter Board Original')).toBe(1);
    expect(resolver.resolve('10', 'Kilter Board Original')).toBe(1); // another variant, same board layout
    expect(resolver.resolve('17', 'Kilter Board Homewall')).toBe(8);
  });

  it('normalizes product-name casing/whitespace', async () => {
    const resolver = await buildLayoutResolver(mockDb({ layouts: LAYOUTS, products: PRODUCTS, aliases: [] }));
    expect(resolver.resolve('27', '  kilter   board ORIGINAL ')).toBe(1);
  });

  it('returns null for an ambiguous (multi-layout) product', async () => {
    const resolver = await buildLayoutResolver(mockDb({ layouts: LAYOUTS, products: PRODUCTS, aliases: [] }));
    expect(resolver.resolve('16', 'Tycho')).toBeNull();
    expect(resolver.unmapped()).toEqual(expect.arrayContaining([{ productLayoutUuid: '16', productName: 'Tycho' }]));
  });

  it('returns null for a product board_* has never seen', async () => {
    const resolver = await buildLayoutResolver(mockDb({ layouts: LAYOUTS, products: PRODUCTS, aliases: [] }));
    expect(resolver.resolve('33', 'UP Board')).toBeNull();
  });

  it('prefers a persisted alias over heuristics', async () => {
    const resolver = await buildLayoutResolver(
      mockDb({ layouts: LAYOUTS, products: PRODUCTS, aliases: [{ layoutUuid: '16', layoutId: 6 }] }),
    );
    expect(resolver.resolve('16', 'Tycho')).toBe(6); // would be ambiguous, but persisted wins
  });

  it('accumulates new aliases for persistence', async () => {
    const resolver = await buildLayoutResolver(mockDb({ layouts: LAYOUTS, products: PRODUCTS, aliases: [] }));
    resolver.resolve('27', 'Kilter Board Original');
    resolver.resolve('16', 'Tycho'); // unmapped → no alias
    const aliases = resolver.drainNewAliases();
    expect(aliases).toEqual([{ boardType: 'kilter', layoutUuid: '27', layoutId: 1, source: 'single-layout' }]);
  });
});
