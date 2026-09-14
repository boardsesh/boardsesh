import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { aliveHolds, recomputeMissingHoldCounts } from '../holds';
import { allocateHoldIds, allocateWallIds } from '../ids';
import { createSprayWallCatalogueRows } from '../catalogue-rows';

/**
 * The integrity recompute and the deletion tombstones, against real Postgres.
 *
 * The fixture is the case a reset actually produces: three climbs on one wall,
 * one hold taken off that TWO of them use. Both must land on
 * `missing_hold_count = 1` — not 2 on one and 0 on the other, and not 1 on every
 * climb of the wall — and the third, which never used the hold, must land on 0.
 * A SECOND wall carries a removed hold with the same hold id, so a recompute
 * that forgot to scope the join by `wall_id` (or the update by `layout_id`)
 * fails here rather than passing a shape assertion.
 *
 * Opt-in: point SPRAY_WALL_DB_URL at a throwaway dev DB migrated to >= 0228.
 * Never point it at a database anything else is using — the fixture writes and
 * deletes rows. Note that `vp run test:db` does NOT forward the variable into
 * the package script, so run the files directly:
 *
 *   SPRAY_WALL_DB_URL=postgres://postgres:password@localhost:5544/main \
 *     vp exec tsx --test 'src/queries/spray-walls/__tests__/*.test.ts'
 */
const DB_URL = process.env.SPRAY_WALL_DB_URL;
/** Seeded test user present in the dev DB image. */
const TEST_OWNER = '00000000-0000-0000-0000-000000000001';

if (!DB_URL) {
  // Printed, not silent: a skipped suite and a suite that never ran look
  // identical in the summary, and this one covers behaviour nothing else does.
  console.info('[spray-walls] SPRAY_WALL_DB_URL is unset — skipping the Postgres integrity/tombstone suite.');
  void describe('spray wall integrity recompute', () => {
    void it('skipped — set SPRAY_WALL_DB_URL to a migrated throwaway dev DB to run', { skip: true }, () => {});
  });
} else {
  const sql = postgres(DB_URL, { prepare: false, max: 2, idle_timeout: 5 });
  const db = drizzle(sql);
  const tag = `spraytest-${Date.now()}`;
  // Far above any real catalogue id, so the fixture cannot collide with seeded
  // board data or with a wall a developer created by hand.
  const layoutIdA = 900_000_000 + (Date.now() % 1_000_000);
  const layoutIdB = layoutIdA + 1;
  const boardUuidA = `${tag}-board-a`;
  const boardUuidB = `${tag}-board-b`;
  const climbUuids = [`${tag}-intact`, `${tag}-lost-a`, `${tag}-lost-b`];
  const otherWallClimbUuid = `${tag}-other-wall`;
  const allClimbUuids = [...climbUuids, otherWallClimbUuid];

  async function insertWall(boardUuid: string, layoutId: number): Promise<number> {
    await sql`
      INSERT INTO user_boards (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, has_leds)
      VALUES (${boardUuid}, ${boardUuid}, ${TEST_OWNER}, 'spray', ${layoutId}, ${layoutId}, '1', 'Fixture wall', false)`;
    const [wall] = await sql`
      INSERT INTO spray_walls (board_uuid, layout_id, reference_width, reference_height)
      VALUES (${boardUuid}, ${layoutId}, 3000, 2000)
      RETURNING id`;
    return Number(wall.id);
  }

  async function insertVersion(wallId: number, versionNumber: number, status: string): Promise<number> {
    const [version] = await sql`
      INSERT INTO spray_wall_versions (wall_id, version_number, status, published_at)
      VALUES (${wallId}, ${versionNumber}, ${status}, now())
      RETURNING id`;
    return Number(version.id);
  }

  async function countsByClimb(uuids: string[]): Promise<Map<string, number | null>> {
    const rows = await sql`SELECT uuid, missing_hold_count FROM board_climbs WHERE uuid = ANY(${uuids})`;
    return new Map(rows.map((row) => [row.uuid as string, row.missing_hold_count as number | null]));
  }

  async function tombstoneCount(layoutId: number): Promise<number> {
    const [row] = await sql`
      SELECT count(*)::int AS total FROM sync_deletions
      WHERE table_name = 'spray_walls' AND record_id = ${String(layoutId)}`;
    return row.total as number;
  }

  void describe('spray wall integrity recompute', () => {
    after(async () => {
      await sql`DELETE FROM board_climb_holds WHERE climb_uuid = ANY(${allClimbUuids})`;
      await sql`DELETE FROM board_climbs WHERE uuid = ANY(${allClimbUuids})`;
      await sql`DELETE FROM spray_walls WHERE layout_id = ANY(${[layoutIdA, layoutIdB]})`;
      await sql`DELETE FROM user_boards WHERE uuid = ANY(${[boardUuidA, boardUuidB]})`;
      await sql`
        DELETE FROM sync_deletions
        WHERE table_name = 'spray_walls' AND record_id = ANY(${[String(layoutIdA), String(layoutIdB)]})`;
    });

    void it('counts a removed hold once per climb that uses it, on this wall only', async () => {
      const wallIdA = await insertWall(boardUuidA, layoutIdA);
      const versionOne = await insertVersion(wallIdA, 1, 'superseded');
      const versionTwo = await insertVersion(wallIdA, 2, 'published');

      // Wall A: holds 1-3 survive the reset; hold 4 came off in version 2.
      for (const holdId of [1, 2, 3]) {
        await sql`
          INSERT INTO spray_wall_holds (wall_id, hold_id, cx, cy, r, installed_version_id)
          VALUES (${wallIdA}, ${holdId}, ${holdId * 100}, 500, 40, ${versionOne})`;
      }
      await sql`
        INSERT INTO spray_wall_holds (wall_id, hold_id, cx, cy, r, installed_version_id, removed_version_id)
        VALUES (${wallIdA}, 4, 400, 500, 40, ${versionOne}, ${versionTwo})`;

      // Wall B reuses hold ids 1 and 2 — every wall's ids are its own — and has
      // taken hold 1 off. Nothing about it may reach wall A's climbs.
      const wallIdB = await insertWall(boardUuidB, layoutIdB);
      const versionOneB = await insertVersion(wallIdB, 1, 'superseded');
      const versionTwoB = await insertVersion(wallIdB, 2, 'published');
      await sql`
        INSERT INTO spray_wall_holds (wall_id, hold_id, cx, cy, r, installed_version_id, removed_version_id)
        VALUES (${wallIdB}, 1, 100, 500, 40, ${versionOneB}, ${versionTwoB})`;
      await sql`
        INSERT INTO spray_wall_holds (wall_id, hold_id, cx, cy, r, installed_version_id)
        VALUES (${wallIdB}, 2, 200, 500, 40, ${versionOneB})`;

      for (const uuid of climbUuids) {
        await sql`
          INSERT INTO board_climbs (uuid, board_type, layout_id, name, angle, is_listed, is_draft)
          VALUES (${uuid}, 'spray', ${layoutIdA}, ${uuid}, 40, true, false)`;
      }
      await sql`
        INSERT INTO board_climbs (uuid, board_type, layout_id, name, angle, is_listed, is_draft)
        VALUES (${otherWallClimbUuid}, 'spray', ${layoutIdB}, ${otherWallClimbUuid}, 40, true, false)`;

      // intact: holds 1,2 — lost-a: 1,4 — lost-b: 3,4. The removed hold 4 is
      // shared by the two "lost" climbs. The wall-B climb uses its own hold 1,
      // which IS removed — on wall B.
      const holdsPerClimb: Record<string, number[]> = {
        [climbUuids[0]]: [1, 2],
        [climbUuids[1]]: [1, 4],
        [climbUuids[2]]: [3, 4],
        [otherWallClimbUuid]: [1, 2],
      };
      for (const [uuid, holds] of Object.entries(holdsPerClimb)) {
        for (const holdId of holds) {
          await sql`
            INSERT INTO board_climb_holds (board_type, climb_uuid, hold_id, frame_number, hold_state)
            VALUES ('spray', ${uuid}, ${holdId}, 0, 'HAND')`;
        }
      }

      const changed = await recomputeMissingHoldCounts(db, wallIdA);
      assert.equal(changed, 3, 'only wall A’s three climbs move off NULL');

      const counts = await countsByClimb(allClimbUuids);
      assert.equal(counts.get(climbUuids[0]), 0, 'a climb using no removed hold of THIS wall is intact');
      assert.equal(counts.get(climbUuids[1]), 1, 'the shared removed hold counts once here');
      assert.equal(counts.get(climbUuids[2]), 1, 'and once here — not twice on one climb');
      assert.equal(counts.get(otherWallClimbUuid), null, "another wall's climbs are not touched");
    });

    void it('is idempotent: a second pass changes nothing', async () => {
      const [wall] = await sql`SELECT id FROM spray_walls WHERE layout_id = ${layoutIdA}`;
      assert.equal(await recomputeMissingHoldCounts(db, Number(wall.id)), 0);
    });

    void it('aliveHolds reports the current generation, and the previous one on request', async () => {
      const [wall] = await sql`SELECT id FROM spray_walls WHERE layout_id = ${layoutIdA}`;
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

    void it('tombstones a SOFT-deleted wall by its layout id, scoped to the owner', async () => {
      // The only delete path there is: nothing hard-deletes a wall row.
      await sql`UPDATE spray_walls SET deleted_at = now() WHERE layout_id = ${layoutIdA}`;

      const [tombstone] = await sql`
        SELECT record_id, user_id FROM sync_deletions
        WHERE table_name = 'spray_walls' AND record_id = ${String(layoutIdA)}`;
      assert.ok(tombstone, 'soft-deleting a wall must leave a tombstone');
      assert.equal(tombstone.user_id, TEST_OWNER, 'a private wall is never tombstoned for every client');
      assert.equal(await tombstoneCount(layoutIdA), 1, 'exactly one tombstone');
    });

    void it('does not tombstone twice when the soft delete is re-applied', async () => {
      await sql`UPDATE spray_walls SET deleted_at = now() WHERE layout_id = ${layoutIdA}`;
      await sql`UPDATE spray_walls SET updated_at = now() WHERE layout_id = ${layoutIdA}`;
      assert.equal(await tombstoneCount(layoutIdA), 1, 'an idempotent retry writes no second tombstone');
    });

    void it('still tombstones a hard delete, for the row removed by hand', async () => {
      await sql`DELETE FROM spray_walls WHERE layout_id = ${layoutIdA}`;
      assert.equal(await tombstoneCount(layoutIdA), 2, 'the hard-delete trigger fires too');
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
