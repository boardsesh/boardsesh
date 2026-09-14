import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { aliveHolds, recomputeMissingHoldCounts } from '../holds';
import { allocateHoldIds, allocateWallIds } from '../ids';
import { createSprayWallCatalogueRows } from '../catalogue-rows';

/**
 * The integrity recompute, against real Postgres.
 *
 * The fixture is the case a reset actually produces: three climbs on one wall,
 * one hold taken off that TWO of them use. Both must land on
 * `missing_hold_count = 1` — not 2 on one and 0 on the other, and not 1 on every
 * climb of the wall — and the third, which never used the hold, must land on 0.
 * A shape assertion over the SQL cannot tell those apart, which is why this test
 * needs a database.
 *
 * Opt-in: point SPRAY_WALL_DB_URL at a dev DB migrated to >= 0228
 * (`vp run db:up`, then the URL from .boardsesh/dev-db.env). Self-skips
 * otherwise so dataless machines stay green.
 *
 *   SPRAY_WALL_DB_URL=postgres://postgres:password@localhost:5432/main vp run test:db
 */
const DB_URL = process.env.SPRAY_WALL_DB_URL;
/** Seeded test user present in the dev DB image. */
const TEST_OWNER = '00000000-0000-0000-0000-000000000001';

if (!DB_URL) {
  void describe('spray wall integrity recompute', () => {
    void it('skipped — set SPRAY_WALL_DB_URL to a migrated dev DB to run', { skip: true }, () => {});
  });
} else {
  const sql = postgres(DB_URL, { prepare: false, max: 2, idle_timeout: 5 });
  const db = drizzle(sql);
  const tag = `spraytest-${Date.now()}`;
  const boardUuid = `${tag}-board`;
  // Far above any real catalogue id, so the fixture cannot collide with seeded
  // board data or with a wall a developer created by hand.
  const layoutId = 900_000_000 + (Date.now() % 1_000_000);
  const climbUuids = [`${tag}-intact`, `${tag}-lost-a`, `${tag}-lost-b`];

  void describe('spray wall integrity recompute', () => {
    after(async () => {
      await sql`DELETE FROM board_climb_holds WHERE climb_uuid = ANY(${climbUuids})`;
      await sql`DELETE FROM board_climbs WHERE uuid = ANY(${climbUuids})`;
      await sql`DELETE FROM spray_walls WHERE layout_id = ${layoutId}`;
      await sql`DELETE FROM user_boards WHERE uuid = ${boardUuid}`;
    });

    void it('counts a removed hold once per climb that uses it', async () => {
      await sql`
        INSERT INTO user_boards (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, has_leds)
        VALUES (${boardUuid}, ${tag}, ${TEST_OWNER}, 'spray', ${layoutId}, ${layoutId}, '1', 'Fixture wall', false)`;

      const [wall] = await sql`
        INSERT INTO spray_walls (board_uuid, layout_id, reference_width, reference_height)
        VALUES (${boardUuid}, ${layoutId}, 3000, 2000)
        RETURNING id`;
      const wallId = Number(wall.id);

      const [versionOne] = await sql`
        INSERT INTO spray_wall_versions (wall_id, version_number, status, published_at)
        VALUES (${wallId}, 1, 'superseded', now())
        RETURNING id`;
      const [versionTwo] = await sql`
        INSERT INTO spray_wall_versions (wall_id, version_number, status, published_at)
        VALUES (${wallId}, 2, 'published', now())
        RETURNING id`;

      // Holds 1-3 survive the reset; hold 4 came off in version 2.
      for (const holdId of [1, 2, 3]) {
        await sql`
          INSERT INTO spray_wall_holds (wall_id, hold_id, cx, cy, r, installed_version_id)
          VALUES (${wallId}, ${holdId}, ${holdId * 100}, 500, 40, ${versionOne.id})`;
      }
      await sql`
        INSERT INTO spray_wall_holds (wall_id, hold_id, cx, cy, r, installed_version_id, removed_version_id)
        VALUES (${wallId}, 4, 400, 500, 40, ${versionOne.id}, ${versionTwo.id})`;

      for (const uuid of climbUuids) {
        await sql`
          INSERT INTO board_climbs (uuid, board_type, layout_id, name, angle, is_listed, is_draft)
          VALUES (${uuid}, 'spray', ${layoutId}, ${uuid}, 40, true, false)`;
      }
      // intact: holds 1,2 — lost-a: 1,4 — lost-b: 3,4. The removed hold 4 is
      // shared by the two "lost" climbs.
      const holdsPerClimb: Record<string, number[]> = {
        [climbUuids[0]]: [1, 2],
        [climbUuids[1]]: [1, 4],
        [climbUuids[2]]: [3, 4],
      };
      for (const [uuid, holds] of Object.entries(holdsPerClimb)) {
        for (const holdId of holds) {
          await sql`
            INSERT INTO board_climb_holds (board_type, climb_uuid, hold_id, frame_number, hold_state)
            VALUES ('spray', ${uuid}, ${holdId}, 0, 'HAND')`;
        }
      }

      const changed = await recomputeMissingHoldCounts(db, wallId);
      assert.equal(changed, 3, 'every climb on the wall moves off NULL on the first pass');

      const counts = new Map(
        (await sql`SELECT uuid, missing_hold_count FROM board_climbs WHERE uuid = ANY(${climbUuids})`).map((row) => [
          row.uuid as string,
          row.missing_hold_count as number,
        ]),
      );
      assert.equal(counts.get(climbUuids[0]), 0, 'a climb using no removed hold is intact');
      assert.equal(counts.get(climbUuids[1]), 1, 'the shared removed hold counts once here');
      assert.equal(counts.get(climbUuids[2]), 1, 'and once here — not twice on one climb');
    });

    void it('is idempotent: a second pass changes nothing', async () => {
      const [wall] = await sql`SELECT id FROM spray_walls WHERE layout_id = ${layoutId}`;
      assert.equal(await recomputeMissingHoldCounts(db, Number(wall.id)), 0);
    });

    void it('aliveHolds reports the current generation, and the previous one on request', async () => {
      const [wall] = await sql`SELECT id FROM spray_walls WHERE layout_id = ${layoutId}`;
      const wallId = Number(wall.id);

      assert.deepEqual(
        (await aliveHolds(db, wallId)).map((hold) => hold.holdId),
        [1, 2, 3],
        'the removed hold is gone from today',
      );
      assert.deepEqual(
        (await aliveHolds(db, wallId, 1)).map((hold) => hold.holdId),
        [1, 2, 3, 4],
        'but was still on the wall at version 1',
      );
    });

    void it('tombstones a deleted wall by its layout id, scoped to the owner', async () => {
      const [wall] = await sql`SELECT id FROM spray_walls WHERE layout_id = ${layoutId}`;
      await sql`DELETE FROM spray_walls WHERE id = ${wall.id}`;

      const [tombstone] = await sql`
        SELECT record_id, user_id FROM sync_deletions
        WHERE table_name = 'spray_walls' AND record_id = ${String(layoutId)}`;
      assert.ok(tombstone, 'deleting a wall must leave a tombstone');
      assert.equal(tombstone.user_id, TEST_OWNER, 'a private wall is never tombstoned for every client');

      await sql`DELETE FROM sync_deletions WHERE table_name = 'spray_walls' AND record_id = ${String(layoutId)}`;
    });
  });

  void describe('spray wall catalogue allocation', () => {
    const seeded: number[] = [];

    after(async () => {
      for (const id of seeded) {
        await sql`DELETE FROM board_product_sizes_layouts_sets WHERE board_type = 'spray' AND id = ${id}`;
        await sql`DELETE FROM board_product_sizes WHERE board_type = 'spray' AND id = ${id}`;
        await sql`DELETE FROM board_layouts WHERE board_type = 'spray' AND id = ${id}`;
      }
      // The connection is shared by both suites, so it closes last of all.
      await sql.end();
    });

    void it('allocates from the real sequences and writes three UNLISTED rows', async () => {
      const ids = await allocateWallIds(db);
      seeded.push(ids.layoutId);
      assert.equal(ids.sizeId, ids.layoutId);

      const holdIds = await allocateHoldIds(db, 3);
      assert.equal(new Set(holdIds).size, 3);
      assert.ok(holdIds[1] > holdIds[0] && holdIds[2] > holdIds[1]);

      await createSprayWallCatalogueRows(db, {
        layoutId: ids.layoutId,
        name: 'Fixture wall',
        referenceWidth: 3000,
        referenceHeight: 2000,
      });

      const [layout] =
        await sql`SELECT is_listed FROM board_layouts WHERE board_type = 'spray' AND id = ${ids.layoutId}`;
      const [size] =
        await sql`SELECT is_listed FROM board_product_sizes WHERE board_type = 'spray' AND id = ${ids.sizeId}`;
      const [join] =
        await sql`SELECT is_listed, set_id FROM board_product_sizes_layouts_sets WHERE board_type = 'spray' AND id = ${ids.layoutId}`;
      assert.equal(layout.is_listed, false);
      assert.equal(size.is_listed, false);
      assert.equal(join.is_listed, false);
      assert.equal(join.set_id, 1);
    });
  });
}
