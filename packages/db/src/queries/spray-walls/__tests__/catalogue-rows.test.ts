import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getTableName } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { createSprayWallCatalogueRows } from '../catalogue-rows';

type DrizzleDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

type CapturedInsert = { table: string; values: Record<string, unknown> };

/**
 * A fake handle capturing `db.insert(table).values(row)` without a Postgres.
 * What is under test is the CONTENT of the three catalogue rows — above all
 * `is_listed`, which is the wall's primary privacy defence (#5453 review).
 */
function makeInsertDb() {
  const inserts: CapturedInsert[] = [];
  const handle = {
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        inserts.push({ table: getTableName(table as Parameters<typeof getTableName>[0]), values });
        return Promise.resolve([]);
      },
    }),
  };
  return { inserts, handle: handle as unknown as DrizzleDb };
}

async function seedWall(overrides: Partial<Parameters<typeof createSprayWallCatalogueRows>[1]> = {}) {
  const db = makeInsertDb();
  await createSprayWallCatalogueRows(db.handle, {
    layoutId: 42,
    name: "Marco's garage",
    referenceWidth: 3000,
    referenceHeight: 2000,
    ...overrides,
  });
  return db.inserts;
}

void describe('createSprayWallCatalogueRows', () => {
  void it('writes exactly the layout, the size and the join row', async () => {
    const inserts = await seedWall();
    assert.deepEqual(
      inserts.map((insert) => insert.table),
      ['board_layouts', 'board_product_sizes', 'board_product_sizes_layouts_sets'],
    );
  });

  void it('marks EVERY catalogue row is_listed = false', async () => {
    // A wall is one climber's private property. getPopularConfigs and the
    // sitemap shards also drop spray by name, but any other reader of these
    // tables has only is_listed to go on — a listed row here is a privacy bug.
    for (const insert of await seedWall()) {
      assert.equal(insert.values.isListed, false, `${insert.table} must be seeded unlisted`);
    }
  });

  void it('gives the size row the SAME id as the layout row', async () => {
    const [layout, size, join] = await seedWall();
    assert.equal(layout.values.id, 42);
    assert.equal(size.values.id, 42);
    assert.equal(join.values.productSizeId, 42);
    assert.equal(join.values.layoutId, 42);
  });

  void it('hangs every row off the one spray product and the one "Holds" set', async () => {
    const [layout, size, join] = await seedWall();
    assert.equal(layout.values.boardType, 'spray');
    assert.equal(layout.values.productId, 1);
    assert.equal(size.values.productId, 1);
    assert.equal(join.values.setId, 1);
    assert.equal(join.values.boardType, 'spray');
  });

  void it('makes the size edge box the canonical frame', async () => {
    const [, size] = await seedWall();
    assert.equal(size.values.edgeLeft, 0);
    assert.equal(size.values.edgeBottom, 0);
    assert.equal(size.values.edgeRight, 3000);
    assert.equal(size.values.edgeTop, 2000);
  });

  void it('leaves the edge box null before the first photo is measured', async () => {
    const [, size] = await seedWall({ referenceWidth: undefined, referenceHeight: undefined });
    assert.equal(size.values.edgeRight, null);
    assert.equal(size.values.edgeTop, null);
  });

  void it('never mirrors a wall', async () => {
    const [layout] = await seedWall();
    assert.equal(layout.values.isMirrored, false);
  });
});
