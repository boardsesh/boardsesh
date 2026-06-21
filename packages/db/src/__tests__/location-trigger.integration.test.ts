import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';

/**
 * Integration coverage for the gyms_set_location / user_boards_set_location
 * triggers (migration 0127). The triggers derive the PostGIS `location`
 * geography from lat/lng on every insert/update — the behaviour the location-
 * sync importer now relies on instead of a manual `UPDATE ... SET location`.
 * Without this, dropping/renaming the trigger (or running against a pre-0127
 * DB) would silently leave `location` NULL and break proximity search, with no
 * error surfaced. The importer's own unit tests cover pure planning only, so
 * this is where the trigger dependency is actually exercised.
 *
 * Opt-in: set LOCATION_TRIGGER_DB_URL to a PostGIS dev DB migrated to >= 0127
 * (`vp run db:up`, then the URL from .boardsesh/dev-db.env). Self-skips
 * otherwise so CI and dataless machines stay green. The backend test DB
 * (plain postgres:15, no PostGIS) cannot run this.
 *
 *   cd packages/db && LOCATION_TRIGGER_DB_URL=postgres://postgres:password@localhost:5432/main bun run test
 */
const DB_URL = process.env.LOCATION_TRIGGER_DB_URL;
// Seeded test user present in the dev DB image.
const TEST_OWNER = '00000000-0000-0000-0000-000000000001';

if (!DB_URL) {
  void describe('location triggers (migration 0127)', () => {
    void it('skipped — set LOCATION_TRIGGER_DB_URL to a migrated PostGIS dev DB to run', { skip: true }, () => {});
  });
} else {
  const sql = postgres(DB_URL, { prepare: false, max: 2, idle_timeout: 5 });
  const tag = `trigtest-${Date.now()}`;
  const gymUuid = `${tag}-gym`;
  const boardUuid = `${tag}-board`;

  void describe('location triggers (migration 0127)', () => {
    after(async () => {
      await sql`DELETE FROM user_boards WHERE uuid = ${boardUuid}`;
      await sql`DELETE FROM gyms WHERE uuid = ${gymUuid}`;
      await sql.end();
    });

    void it('installs both triggers', async () => {
      const rows = await sql`
        SELECT tgname FROM pg_trigger
        WHERE tgname IN ('gyms_set_location', 'user_boards_set_location')`;
      assert.equal(rows.length, 2, 'migration 0127 triggers must be installed');
    });

    void it('derives gyms.location from lat/lng on insert (no manual UPDATE)', async () => {
      await sql`
        INSERT INTO gyms (uuid, name, owner_id, latitude, longitude, is_public)
        VALUES (${gymUuid}, 'Trigger Test Gym', ${TEST_OWNER}, -33, 150, true)`;
      const [row] = await sql`SELECT ST_AsText(location::geometry) AS wkt FROM gyms WHERE uuid = ${gymUuid}`;
      assert.equal(row.wkt, 'POINT(150 -33)');
    });

    void it('keeps gyms.location in sync when lat/lng change', async () => {
      await sql`UPDATE gyms SET latitude = 35, longitude = 139 WHERE uuid = ${gymUuid}`;
      const [row] = await sql`SELECT ST_AsText(location::geometry) AS wkt FROM gyms WHERE uuid = ${gymUuid}`;
      assert.equal(row.wkt, 'POINT(139 35)');
    });

    void it('nulls gyms.location when coordinates are cleared', async () => {
      await sql`UPDATE gyms SET latitude = NULL WHERE uuid = ${gymUuid}`;
      const [row] = await sql`SELECT location FROM gyms WHERE uuid = ${gymUuid}`;
      assert.equal(row.location, null);
    });

    void it('derives user_boards.location from lat/lng on insert', async () => {
      await sql`
        INSERT INTO user_boards
          (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, latitude, longitude, is_public)
        VALUES (${boardUuid}, ${boardUuid}, ${TEST_OWNER}, 'kilter', 1, 10, ${tag}, 'Trigger Test Wall', 40, -105, true)`;
      const [row] = await sql`SELECT ST_AsText(location::geometry) AS wkt FROM user_boards WHERE uuid = ${boardUuid}`;
      assert.equal(row.wkt, 'POINT(-105 40)');
    });
  });
}
