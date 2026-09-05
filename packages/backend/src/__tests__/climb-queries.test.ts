import { describe, it, expect, beforeAll, afterAll } from 'vite-plus/test';
import {
  searchClimbs,
  countClimbs,
  getClimbByUuid,
  type ParsedBoardRouteParameters,
  type ClimbSearchParams,
} from '../db/queries/climbs/index';
import { populateDenormalizedColumns } from '@boardsesh/db/queries';
import { db } from '../db/client';
import { sql } from 'drizzle-orm';

describe('Climb Query Functions', () => {
  const testParams: ParsedBoardRouteParameters = {
    board_name: 'kilter',
    layout_id: 1,
    size_id: 7,
    set_ids: [1, 2],
    angle: 40,
  };

  describe('searchClimbs', () => {
    it('should return climbs with basic filters', async () => {
      const searchParams: ClimbSearchParams = {
        page: 0,
        pageSize: 10,
        sortBy: 'ascents',
        sortOrder: 'desc',
      };

      const result = await searchClimbs(testParams, searchParams);

      expect(result).toBeDefined();
      expect(result.climbs).toBeInstanceOf(Array);
      expect(result.hasMore).toBeDefined();
      expect(typeof result.hasMore).toBe('boolean');
      expect(result.totalCount).toBeDefined();
      expect(typeof result.totalCount).toBe('number');

      // Each result carries the searched board + layout so a queued climb can be
      // checked against a connected board (BLE spill guard). The search is scoped
      // to testParams (kilter / layout 1) by its WHERE clause.
      if (result.climbs.length > 0) {
        expect(result.climbs[0].boardType).toBe('kilter');
        expect(result.climbs[0].layoutId).toBe(1);
      }
    });

    it('should enforce MAX_PAGE_SIZE limit', async () => {
      const searchParams: ClimbSearchParams = {
        page: 0,
        pageSize: 200, // Exceeds MAX_PAGE_SIZE of 100
      };

      const result = await searchClimbs(testParams, searchParams);

      // Should succeed but cap the results
      expect(result).toBeDefined();
      expect(result.climbs.length).toBeLessThanOrEqual(100);
    });

    it('should respect pageSize parameter', async () => {
      const searchParams: ClimbSearchParams = {
        page: 0,
        pageSize: 5,
      };

      const result = await searchClimbs(testParams, searchParams);

      // Should return at most 5 climbs (might be less if not enough data)
      expect(result.climbs.length).toBeLessThanOrEqual(5);
    });

    it('should filter by grade range', async () => {
      const searchParams: ClimbSearchParams = {
        page: 0,
        pageSize: 10,
        minGrade: 5,
        maxGrade: 8,
      };

      const result = await searchClimbs(testParams, searchParams);

      expect(result).toBeDefined();
      // All climbs should be within grade range (if any returned)
      result.climbs.forEach((climb) => {
        if (climb.difficulty) {
          // Grade validation would go here
          expect(climb).toBeDefined();
        }
      });
    });

    it('should filter by minimum ascents', async () => {
      const searchParams: ClimbSearchParams = {
        page: 0,
        pageSize: 10,
        minAscents: 50,
      };

      const result = await searchClimbs(testParams, searchParams);

      expect(result).toBeDefined();
      // All climbs should have >= 50 ascents
      result.climbs.forEach((climb) => {
        expect(climb.ascensionist_count).toBeGreaterThanOrEqual(50);
      });
    });

    it('should filter by climb name', async () => {
      const searchParams: ClimbSearchParams = {
        page: 0,
        pageSize: 10,
        name: 'test',
      };

      const result = await searchClimbs(testParams, searchParams);

      expect(result).toBeDefined();
      // All climbs should match name pattern (case insensitive)
      result.climbs.forEach((climb) => {
        if (climb.name) {
          expect(climb.name.toLowerCase()).toContain('test');
        }
      });
    });

    it('should indicate hasMore correctly', async () => {
      const searchParams: ClimbSearchParams = {
        page: 0,
        pageSize: 1,
      };

      const result = await searchClimbs(testParams, searchParams);

      // If more than 1 climb exists, hasMore should be true
      if (result.totalCount > 1) {
        expect(result.hasMore).toBe(true);
      }
    });

    it('should handle invalid board parameters gracefully', async () => {
      const invalidParams: ParsedBoardRouteParameters = {
        board_name: 'kilter',
        layout_id: 1,
        size_id: 999999, // Invalid size_id
        set_ids: [1],
        angle: 40,
      };

      const searchParams: ClimbSearchParams = {
        page: 0,
        pageSize: 10,
      };

      const result = await searchClimbs(invalidParams, searchParams);

      // Should return empty results for invalid size
      expect(result.climbs).toEqual([]);
      expect(result.totalCount).toBe(0);
      expect(result.hasMore).toBe(false);
    });

    it('should accept userId for personal progress filters without error', async () => {
      const searchParams: ClimbSearchParams = {
        page: 0,
        pageSize: 10,
      };

      const result = await searchClimbs(testParams, searchParams, 'some-user-id');

      expect(result).toBeDefined();
      expect(result.climbs).toBeInstanceOf(Array);
    });

    it('should handle pagination correctly', async () => {
      const page0Params: ClimbSearchParams = {
        page: 0,
        pageSize: 5,
      };

      const page1Params: ClimbSearchParams = {
        page: 1,
        pageSize: 5,
      };

      const page0Result = await searchClimbs(testParams, page0Params);
      const page1Result = await searchClimbs(testParams, page1Params);

      // Results from different pages should be different (if enough data exists)
      if (page0Result.totalCount > 5) {
        const page0Uuids = page0Result.climbs.map((c) => c.uuid);
        const page1Uuids = page1Result.climbs.map((c) => c.uuid);

        // Check that pages don't overlap
        const overlap = page0Uuids.some((uuid) => page1Uuids.includes(uuid));
        expect(overlap).toBe(false);
      }
    });
  });

  describe('countClimbs', () => {
    it('should return accurate total count', async () => {
      const searchParams: ClimbSearchParams = {
        page: 0,
        pageSize: 10,
      };

      const searchResult = await searchClimbs(testParams, searchParams);
      const count = await countClimbs(testParams, searchParams);

      // Count should match totalCount from search
      expect(count).toBe(searchResult.totalCount);
    });

    it('should respect filters in count', async () => {
      const filteredParams: ClimbSearchParams = {
        page: 0,
        pageSize: 10,
        minAscents: 100,
      };

      const unfilteredParams: ClimbSearchParams = {
        page: 0,
        pageSize: 10,
      };

      const filteredCount = await countClimbs(testParams, filteredParams);
      const unfilteredCount = await countClimbs(testParams, unfilteredParams);

      // Filtered count should be <= unfiltered count
      expect(filteredCount).toBeLessThanOrEqual(unfilteredCount);
    });
  });

  describe('getClimbByUuid', () => {
    it('should return null for non-existent UUID', async () => {
      const result = await getClimbByUuid({
        board_name: 'kilter',
        layout_id: 1,
        size_id: 1,
        angle: 40,
        climb_uuid: 'non-existent-uuid-12345',
      });

      expect(result).toBeNull();
    });

    it('should handle different board names', async () => {
      // Test with kilter
      const kilterResult = await getClimbByUuid({
        board_name: 'kilter',
        layout_id: 1,
        size_id: 1,
        angle: 40,
        climb_uuid: 'test-uuid',
      });

      // Test with tension
      const tensionResult = await getClimbByUuid({
        board_name: 'tension',
        layout_id: 1,
        size_id: 1,
        angle: 40,
        climb_uuid: 'test-uuid',
      });

      // Both should execute without errors (may return null if no data)
      expect(kilterResult === null || typeof kilterResult === 'object').toBe(true);
      expect(tensionResult === null || typeof tensionResult === 'object').toBe(true);
    });

    describe('alias resolution', () => {
      const ALIAS_PREFIX = 'gcbu-alias-test-';
      const canonicalUuid = `${ALIAS_PREFIX}canonical`;
      const oldAliasUuid = `${ALIAS_PREFIX}old-merged-away`;

      beforeAll(async () => {
        await db.execute(sql`
          INSERT INTO board_climbs (uuid, board_type, layout_id, setter_username, name, frames, frames_count, is_draft, is_listed, edge_left, edge_right, edge_bottom, edge_top, created_at)
          VALUES (${canonicalUuid}, 'kilter', 1, 's', 'Canonical Climb', 'p1r12p2r13', 1, false, true, 0, 11, 0, 18, '2024-01-01')
          ON CONFLICT DO NOTHING
        `);
        await db.execute(sql`
          INSERT INTO board_climb_aliases (board_type, alias_uuid, canonical_uuid, source)
          VALUES ('kilter', ${oldAliasUuid}, ${canonicalUuid}, 'test-fixture')
          ON CONFLICT DO NOTHING
        `);
      });

      afterAll(async () => {
        await db.execute(sql`DELETE FROM board_climb_aliases WHERE alias_uuid = ${oldAliasUuid}`);
        await db.execute(sql`DELETE FROM board_climbs WHERE uuid = ${canonicalUuid}`);
      });

      it('resolves an old/merged uuid to the canonical climb instead of returning null', async () => {
        const result = await getClimbByUuid({
          board_name: 'kilter',
          layout_id: 1,
          size_id: 1,
          angle: 40,
          climb_uuid: oldAliasUuid,
        });

        expect(result).not.toBeNull();
        expect(result?.uuid).toBe(canonicalUuid);
        expect(result?.name).toBe('Canonical Climb');
      });
    });
  });

  describe('set_ids filtering', () => {
    // Seed data for set_ids tests
    // - Placement 100 belongs to set 1 (mainline), layout 1
    // - Placement 200 belongs to set 2 (full ride), layout 1
    // - Climb "mainline-only" uses only placement 100 (set 1)
    // - Climb "full-ride-only" uses only placement 200 (set 2)
    // - Climb "mixed-sets" uses both placement 100 (set 1) and 200 (set 2)
    const SET_IDS_TEST_PREFIX = 'set-ids-test-';

    beforeAll(async () => {
      // Insert placements for two different sets
      await db.execute(sql`
        INSERT INTO board_placements (board_type, id, layout_id, hole_id, set_id, default_placement_role_id)
        VALUES
          ('kilter', 100, 1, 100, 1, NULL),
          ('kilter', 200, 1, 200, 2, NULL)
        ON CONFLICT DO NOTHING
      `);

      // Insert test climbs that fit within size 7 edges
      await db.execute(sql`
        INSERT INTO board_climbs (uuid, board_type, layout_id, setter_username, name, frames, frames_count, is_draft, is_listed, edge_left, edge_right, edge_bottom, edge_top, created_at, required_set_ids, compatible_size_ids)
        VALUES
          (${SET_IDS_TEST_PREFIX + 'mainline'}, 'kilter', 1, 'test-setter', 'Mainline Only', 'p100r43', 1, false, true, 10, 100, 10, 150, '2024-01-01', ARRAY[1], ARRAY[7]),
          (${SET_IDS_TEST_PREFIX + 'fullride'}, 'kilter', 1, 'test-setter', 'Full Ride Only', 'p200r43', 1, false, true, 10, 100, 10, 150, '2024-01-01', ARRAY[2], ARRAY[7]),
          (${SET_IDS_TEST_PREFIX + 'mixed'}, 'kilter', 1, 'test-setter', 'Mixed Sets', 'p100r43p200r44', 1, false, true, 10, 100, 10, 150, '2024-01-01', ARRAY[1, 2], ARRAY[7])
        ON CONFLICT DO NOTHING
      `);

      // MoonBoard climbs (layout 3 = MoonBoard 2024). MoonBoard derives
      // required_set_ids from the grid cell -> set map, not board_placements, so
      // we seed the column directly. Set 5 = Hold Set D (base), set 8 = Wooden
      // Holds. The size filter is skipped for MoonBoard, so edges/sizes are nominal.
      await db.execute(sql`
        INSERT INTO board_climbs (uuid, board_type, layout_id, setter_username, name, frames, frames_count, is_draft, is_listed, edge_left, edge_right, edge_bottom, edge_top, created_at, required_set_ids, compatible_size_ids)
        VALUES
          (${SET_IDS_TEST_PREFIX + 'mb-base'}, 'moonboard', 3, 'test-setter', 'MB Base Only', 'p1r42p9r43', 1, false, true, 0, 11, 0, 18, '2024-01-01', ARRAY[5], ARRAY[1]),
          (${SET_IDS_TEST_PREFIX + 'mb-wooden'}, 'moonboard', 3, 'test-setter', 'MB Needs Wooden', 'p1r42p2r43', 1, false, true, 0, 11, 0, 18, '2024-01-01', ARRAY[5, 8], ARRAY[1]),
          (${SET_IDS_TEST_PREFIX + 'mb-null'}, 'moonboard', 3, 'test-setter', 'MB Not Backfilled', 'p1r42p9r43', 1, false, true, 0, 11, 0, 18, '2024-01-01', NULL, ARRAY[1])
        ON CONFLICT DO NOTHING
      `);

      // Insert climb holds matching the frames
      await db.execute(sql`
        INSERT INTO board_climb_holds (board_type, climb_uuid, hold_id, frame_number, hold_state)
        VALUES
          ('kilter', ${SET_IDS_TEST_PREFIX + 'mainline'}, 100, 0, 'HAND'),
          ('kilter', ${SET_IDS_TEST_PREFIX + 'fullride'}, 200, 0, 'HAND'),
          ('kilter', ${SET_IDS_TEST_PREFIX + 'mixed'}, 100, 0, 'HAND'),
          ('kilter', ${SET_IDS_TEST_PREFIX + 'mixed'}, 200, 0, 'FINISH')
        ON CONFLICT DO NOTHING
      `);
    });

    afterAll(async () => {
      // Clean up test data
      await db.execute(sql`DELETE FROM board_climb_holds WHERE climb_uuid LIKE ${SET_IDS_TEST_PREFIX + '%'}`);
      await db.execute(sql`DELETE FROM board_climbs WHERE uuid LIKE ${SET_IDS_TEST_PREFIX + '%'}`);
      await db.execute(sql`DELETE FROM board_placements WHERE board_type = 'kilter' AND id IN (100, 200)`);
    });

    it('should only return climbs whose holds all belong to selected sets', async () => {
      const params: ParsedBoardRouteParameters = {
        board_name: 'kilter',
        layout_id: 1,
        size_id: 7,
        set_ids: [1], // mainline only
        angle: 40,
      };

      const result = await searchClimbs(params, {
        page: 0,
        pageSize: 100,
        sortBy: 'creation',
        sortOrder: 'desc',
      });
      const uuids = result.climbs.map((c) => c.uuid);

      // Should include mainline-only climb
      expect(uuids).toContain(SET_IDS_TEST_PREFIX + 'mainline');
      // Should NOT include full-ride-only or mixed (has a full-ride hold)
      expect(uuids).not.toContain(SET_IDS_TEST_PREFIX + 'fullride');
      expect(uuids).not.toContain(SET_IDS_TEST_PREFIX + 'mixed');
    });

    it('should return climbs from all selected sets', async () => {
      const params: ParsedBoardRouteParameters = {
        board_name: 'kilter',
        layout_id: 1,
        size_id: 7,
        set_ids: [1, 2], // both mainline and full ride
        angle: 40,
      };

      const result = await searchClimbs(params, {
        page: 0,
        pageSize: 100,
        sortBy: 'creation',
        sortOrder: 'desc',
      });
      const uuids = result.climbs.map((c) => c.uuid);

      // All three climbs should appear when both sets are selected
      expect(uuids).toContain(SET_IDS_TEST_PREFIX + 'mainline');
      expect(uuids).toContain(SET_IDS_TEST_PREFIX + 'fullride');
      expect(uuids).toContain(SET_IDS_TEST_PREFIX + 'mixed');
    });

    it('excludes moonboard climbs that need a hold set the user has not selected', async () => {
      const params: ParsedBoardRouteParameters = {
        board_name: 'moonboard',
        layout_id: 3,
        size_id: 1,
        set_ids: [5, 6, 7], // base hold sets only — no wooden holds (8/9/10)
        angle: 40,
      };

      const result = await searchClimbs(params, { page: 0, pageSize: 100 });
      const uuids = result.climbs.map((c) => c.uuid);

      // Base-only climb shows; the wooden-holds climb is filtered out.
      expect(uuids).toContain(SET_IDS_TEST_PREFIX + 'mb-base');
      expect(uuids).not.toContain(SET_IDS_TEST_PREFIX + 'mb-wooden');
      // A climb without a backfilled required_set_ids still shows (NULL-tolerant).
      expect(uuids).toContain(SET_IDS_TEST_PREFIX + 'mb-null');
    });

    it('includes moonboard wooden-holds climbs once the wooden sets are selected', async () => {
      const params: ParsedBoardRouteParameters = {
        board_name: 'moonboard',
        layout_id: 3,
        size_id: 1,
        set_ids: [5, 6, 7, 8, 9, 10], // base + wooden holds
        angle: 40,
      };

      const result = await searchClimbs(params, { page: 0, pageSize: 100 });
      const uuids = result.climbs.map((c) => c.uuid);

      expect(uuids).toContain(SET_IDS_TEST_PREFIX + 'mb-base');
      expect(uuids).toContain(SET_IDS_TEST_PREFIX + 'mb-wooden');
      expect(uuids).toContain(SET_IDS_TEST_PREFIX + 'mb-null');
    });

    it('should skip set_ids filter when set_ids is empty', async () => {
      const params: ParsedBoardRouteParameters = {
        board_name: 'kilter',
        layout_id: 1,
        size_id: 7,
        set_ids: [],
        angle: 40,
      };

      // Should not throw and should return results (no set filtering applied)
      const result = await searchClimbs(params, {
        page: 0,
        pageSize: 100,
        sortBy: 'creation',
        sortOrder: 'desc',
      });
      const uuids = result.climbs.map((c) => c.uuid);

      // All test climbs should appear since no set filter is applied
      expect(uuids).toContain(SET_IDS_TEST_PREFIX + 'mainline');
      expect(uuids).toContain(SET_IDS_TEST_PREFIX + 'fullride');
      expect(uuids).toContain(SET_IDS_TEST_PREFIX + 'mixed');
    });
  });

  describe('moonboard required_set_ids population', () => {
    // Directly exercises populateMoonBoardRequiredSetIds (the regexp_matches +
    // cell->set CTE that the prod backfill also runs), so a regex or SQL typo is
    // caught here rather than only at backfill time.
    const POP_PREFIX = 'mb-populate-test-';

    beforeAll(async () => {
      // layout 3 (MoonBoard 2024): cell 1->set 5 (base), cell 2->set 8 (wooden),
      // cell 9->set 5 (base), cell 999 uncovered. required_set_ids starts NULL.
      await db.execute(sql`
        INSERT INTO board_climbs (uuid, board_type, layout_id, setter_username, name, frames, frames_count, is_draft, is_listed, edge_left, edge_right, edge_bottom, edge_top, created_at, required_set_ids)
        VALUES
          (${POP_PREFIX + 'base'}, 'moonboard', 3, 's', 'Base', 'p1r42p9r43', 1, false, true, 0, 11, 0, 18, '2024-01-01', NULL),
          (${POP_PREFIX + 'wooden'}, 'moonboard', 3, 's', 'Wooden', 'p1r42p2r43', 1, false, true, 0, 11, 0, 18, '2024-01-01', NULL),
          (${POP_PREFIX + 'uncovered'}, 'moonboard', 3, 's', 'Uncovered', 'p999r42', 1, false, true, 0, 11, 0, 18, '2024-01-01', NULL)
        ON CONFLICT DO NOTHING
      `);
    });

    afterAll(async () => {
      await db.execute(sql`DELETE FROM board_climbs WHERE uuid LIKE ${POP_PREFIX + '%'}`);
    });

    async function requiredSetIds(uuid: string): Promise<number[] | null> {
      const rows = (await db.execute(
        sql`SELECT required_set_ids FROM board_climbs WHERE uuid = ${uuid}`,
      )) as unknown as { required_set_ids: number[] | null }[];
      return rows[0].required_set_ids;
    }

    it('derives required_set_ids from the climb frames and cell->set map', async () => {
      await populateDenormalizedColumns(db, 'moonboard', [
        POP_PREFIX + 'base',
        POP_PREFIX + 'wooden',
        POP_PREFIX + 'uncovered',
      ]);

      expect(await requiredSetIds(POP_PREFIX + 'base')).toEqual([5]);
      // Uses a wooden-holds cell, so the wooden set (8) is required.
      expect(await requiredSetIds(POP_PREFIX + 'wooden')).toEqual([5, 8]);
      // All holds on uncovered cells -> empty array (always shown), not NULL.
      expect(await requiredSetIds(POP_PREFIX + 'uncovered')).toEqual([]);
    });
  });

  describe('Performance and Edge Cases', () => {
    it('should handle empty search results', async () => {
      const searchParams: ClimbSearchParams = {
        page: 999, // Very high page number
        pageSize: 10,
      };

      const result = await searchClimbs(testParams, searchParams);

      expect(result.climbs).toEqual([]);
      expect(result.hasMore).toBe(false);
    });

    it('should handle sorting options', async () => {
      const sortByAscents: ClimbSearchParams = {
        page: 0,
        pageSize: 10,
        sortBy: 'ascents',
        sortOrder: 'desc',
      };

      const sortByQuality: ClimbSearchParams = {
        page: 0,
        pageSize: 10,
        sortBy: 'quality',
        sortOrder: 'desc',
      };

      const ascentsResult = await searchClimbs(testParams, sortByAscents);
      const qualityResult = await searchClimbs(testParams, sortByQuality);

      // Both should succeed
      expect(ascentsResult).toBeDefined();
      expect(qualityResult).toBeDefined();
    });

    it('should handle multiple setters filter', async () => {
      const searchParams: ClimbSearchParams = {
        page: 0,
        pageSize: 10,
        settername: ['setter1', 'setter2'],
      };

      const result = await searchClimbs(testParams, searchParams);

      expect(result).toBeDefined();
    });
  });

  // Regression coverage for the search-climbs hardening PR. Each test seeds its own
  // climbs (and stats/holds where needed) and asserts on membership filtered to the
  // shared prefix, so it tolerates whatever else lives in the test DB.
  describe('search-climbs hardening', () => {
    const PREFIX = 'search-hardening-';
    const id = (suffix: string) => PREFIX + suffix;
    // Boulders default to true, so frames_count NULL/1 climbs match without extra params.
    const kilter1 = (overrides: Partial<ParsedBoardRouteParameters> = {}): ParsedBoardRouteParameters => ({
      board_name: 'kilter',
      layout_id: 1,
      size_id: 7,
      set_ids: [1],
      angle: 40,
      ...overrides,
    });

    beforeAll(async () => {
      // board_climbs: hold A/B (anchored-LIKE), rating HI/LO, popular PN/PO (isolated
      // on size/set 99), drafts predicate N, driver-types T, projects-only PROJ.
      await db.execute(sql`
        INSERT INTO board_climbs (uuid, board_type, layout_id, setter_username, name, frames, frames_count, is_draft, is_listed, edge_left, edge_right, edge_bottom, edge_top, created_at, required_set_ids, compatible_size_ids)
        VALUES
          (${id('hold-a')}, 'kilter', 1, 'sh', 'Hold A', 'p30r12p1200r13', 1, false, true, 10, 100, 10, 150, '2024-01-01', ARRAY[1], ARRAY[7]),
          (${id('hold-b')}, 'kilter', 1, 'sh', 'Hold B', 'p130r12p1200r13', 1, false, true, 10, 100, 10, 150, '2024-01-01', ARRAY[1], ARRAY[7]),
          (${id('rating-hi')}, 'kilter', 1, 'sh', 'Rating Hi', 'p500r12', 1, false, true, 10, 100, 10, 150, '2024-01-01', ARRAY[1], ARRAY[7]),
          (${id('rating-lo')}, 'kilter', 1, 'sh', 'Rating Lo', 'p501r12', 1, false, true, 10, 100, 10, 150, '2024-01-01', ARRAY[1], ARRAY[7]),
          (${id('pop-null')}, 'kilter', 1, 'sh', 'Pop Null', 'p99r12', NULL, false, true, 10, 100, 10, 150, '2024-01-01', ARRAY[99], ARRAY[99]),
          (${id('pop-one')}, 'kilter', 1, 'sh', 'Pop One', 'p99r12', 1, false, true, 10, 100, 10, 150, '2024-01-01', ARRAY[99], ARRAY[99]),
          (${id('draft-pred')}, 'kilter', 1, 'sh', 'Draft Pred', 'p502r12', 1, false, true, 10, 100, 10, 150, '2024-01-01', ARRAY[1], ARRAY[7]),
          (${id('types')}, 'kilter', 1, 'sh', 'Types', 'p503r12', 1, false, true, 10, 100, 10, 150, '2024-01-01', ARRAY[1], ARRAY[7]),
          (${id('proj')}, 'kilter', 1, 'sh', 'Proj', 'p504r12', 1, false, true, 10, 100, 10, 150, '2024-01-01', ARRAY[1], ARRAY[7])
        ON CONFLICT DO NOTHING
      `);

      await db.execute(sql`
        INSERT INTO board_climb_stats (board_type, climb_uuid, angle, display_difficulty, ascensionist_count, difficulty_average, quality_average)
        VALUES
          ('kilter', ${id('rating-hi')}, 40, 20.0, 10, 20.0, 4.5),
          ('kilter', ${id('rating-lo')}, 40, 20.0, 10, 20.0, 1.5),
          ('kilter', ${id('pop-null')}, 40, 20.0, 9999, 20.0, 4.0),
          ('kilter', ${id('pop-one')}, 40, 20.0, 1, 20.0, 4.0),
          ('kilter', ${id('types')}, 40, 20.0, 42, 20.5, 4.5)
        ON CONFLICT DO NOTHING
      `);

      // Boardsesh grades at angle 40: TYPES has a universal grade (COALESCE prefers
      // it over local); RATING-LO has universal=NULL so COALESCE falls back to local.
      // POP-ONE deliberately gets no grade row so the flattened fields come back null.
      await db.execute(sql`
        INSERT INTO board_climb_grades (board_type, climb_uuid, angle, local_grade, universal_grade, confidence, model_version, coeff_version)
        VALUES
          ('kilter', ${id('types')}, 40, 20.0, 21.5, 'confirmed', 'test', 'test'),
          ('kilter', ${id('rating-lo')}, 40, 15.0, NULL, 'provisional', 'test', 'test')
        ON CONFLICT DO NOTHING
      `);

      await db.execute(sql`
        INSERT INTO board_climb_holds (board_type, climb_uuid, hold_id, frame_number, hold_state)
        VALUES
          ('kilter', ${id('hold-a')}, 30, 0, 'HAND'),
          ('kilter', ${id('hold-a')}, 1200, 0, 'FINISH'),
          ('kilter', ${id('hold-b')}, 130, 0, 'HAND'),
          ('kilter', ${id('hold-b')}, 1200, 0, 'FINISH')
        ON CONFLICT DO NOTHING
      `);
    });

    afterAll(async () => {
      await db.execute(sql`DELETE FROM board_climb_holds WHERE climb_uuid LIKE ${PREFIX + '%'}`);
      await db.execute(sql`DELETE FROM board_climb_grades WHERE climb_uuid LIKE ${PREFIX + '%'}`);
      await db.execute(sql`DELETE FROM board_climb_stats WHERE climb_uuid LIKE ${PREFIX + '%'}`);
      await db.execute(sql`DELETE FROM board_climbs WHERE uuid LIKE ${PREFIX + '%'}`);
    });

    describe('anchored hold LIKE (F1)', () => {
      it('ANY include matches the exact hold, not a longer placement id', async () => {
        const result = await searchClimbs(kilter1(), {
          page: 0,
          pageSize: 100,
          sortBy: 'creation',
          holdsFilter: { hold_30: { ANY: 'include' } },
        });
        const uuids = result.climbs.map((c) => c.uuid);
        // hold 30 must match p30r… (A) but NOT p130r… (B).
        expect(uuids).toContain(id('hold-a'));
        expect(uuids).not.toContain(id('hold-b'));
      });

      it('ANY exclude drops the exact hold, not a longer placement id', async () => {
        const result = await searchClimbs(kilter1(), {
          page: 0,
          pageSize: 100,
          sortBy: 'creation',
          holdsFilter: { hold_30: { ANY: 'exclude' } },
        });
        const uuids = result.climbs.map((c) => c.uuid);
        // Excluding hold 30 must keep B (uses 130, not 30) and drop A.
        expect(uuids).toContain(id('hold-b'));
        expect(uuids).not.toContain(id('hold-a'));
      });
    });

    describe('minRating on the 1-5 scale (F2)', () => {
      it('minRating=4 keeps a 4.5-quality climb and drops a 1.5-quality climb', async () => {
        const result = await searchClimbs(kilter1(), { page: 0, pageSize: 100, minRating: 4 });
        const uuids = result.climbs.map((c) => c.uuid);
        expect(uuids).toContain(id('rating-hi'));
        expect(uuids).not.toContain(id('rating-lo'));
      });
    });

    describe('popular sort counts NULL frames_count (F4)', () => {
      it('ranks a NULL-frames_count climb by its ascents instead of pushing it last', async () => {
        const result = await searchClimbs(kilter1({ size_id: 99, set_ids: [99] }), {
          page: 0,
          pageSize: 100,
          sortBy: 'popular',
          sortOrder: 'desc',
        });
        const uuids = result.climbs.map((c) => c.uuid);
        const nullIdx = uuids.indexOf(id('pop-null'));
        const oneIdx = uuids.indexOf(id('pop-one'));
        expect(nullIdx).toBeGreaterThanOrEqual(0);
        expect(oneIdx).toBeGreaterThanOrEqual(0);
        // pop-null has far more ascents, so with NULL counted it sorts first.
        expect(nullIdx).toBeLessThan(oneIdx);
      });
    });

    describe('unified drafts predicate (F7)', () => {
      it('applies the size filter when onlyDrafts is set without a userId', async () => {
        // No userId → not a real drafts query → behaves like a normal listed search,
        // so the size filter must reject a climb that does not fit the requested size.
        const noFit = await searchClimbs(kilter1({ size_id: 999 }), { page: 0, pageSize: 100, onlyDrafts: true });
        expect(noFit.climbs.map((c) => c.uuid)).not.toContain(id('draft-pred'));

        const fits = await searchClimbs(kilter1(), { page: 0, pageSize: 100, onlyDrafts: true });
        expect(fits.climbs.map((c) => c.uuid)).toContain(id('draft-pred'));
      });
    });

    describe('driver type fidelity (F9)', () => {
      it('maps numeric/bigint columns to the expected runtime shapes', async () => {
        const result = await searchClimbs(kilter1(), { page: 0, pageSize: 100, sortBy: 'ascents', sortOrder: 'desc' });
        const row = result.climbs.find((c) => c.uuid === id('types'));
        expect(row).toBeDefined();
        // ascensionist_count: bigint → coerced to a JS number.
        expect(row!.ascensionist_count).toBe(42);
        // quality_average: ROUND(::numeric,2) → preserved as the driver's "4.50" string.
        expect(row!.quality_average).toBe('4.50');
        // difficulty_id 20 → grade label; difficulty_error ROUND(20.5-20.0,2) → "0.50".
        expect(row!.difficulty).toBe('6c/V5');
        expect(row!.difficulty_error).toBe('0.50');
        expect(typeof row!.stars).toBe('number');
      });
    });

    describe('countClimbs projectsOnly keeps stats-less climbs (F3)', () => {
      it('counts a climb with no board_climb_stats row under projectsOnly', async () => {
        const count = await countClimbs(kilter1(), { page: 0, pageSize: 100, projectsOnly: true });
        // PROJ has no stats row; projectsOnly must still count it (join retained).
        expect(count).toBeGreaterThanOrEqual(1);
      });
    });

    describe('flattened Boardsesh grade fields (F10)', () => {
      it('surfaces COALESCE(universal, local) and the confidence tier from board_climb_grades', async () => {
        const result = await searchClimbs(kilter1(), { page: 0, pageSize: 100, sortBy: 'ascents', sortOrder: 'desc' });

        // TYPES has a universal grade → COALESCE prefers it over the local grade.
        const withUniversal = result.climbs.find((c) => c.uuid === id('types'));
        expect(withUniversal).toBeDefined();
        expect(withUniversal!.boardseshDifficulty).toBe(21.5);
        expect(withUniversal!.boardseshConfidence).toBe('confirmed');

        // RATING-LO has universal=NULL → COALESCE falls back to the local grade.
        const localOnly = result.climbs.find((c) => c.uuid === id('rating-lo'));
        expect(localOnly).toBeDefined();
        expect(localOnly!.boardseshDifficulty).toBe(15.0);
        expect(localOnly!.boardseshConfidence).toBe('provisional');

        // RATING-HI has a stats row but no grade row → both fields degrade to
        // null (the safe path) even though the climb itself is returned.
        const noGrade = result.climbs.find((c) => c.uuid === id('rating-hi'));
        expect(noGrade).toBeDefined();
        expect(noGrade!.boardseshDifficulty).toBeNull();
        expect(noGrade!.boardseshConfidence).toBeNull();
      });

      it('getClimbByUuid carries the grade at the requested angle, null when absent', async () => {
        const graded = await getClimbByUuid({
          board_name: 'kilter',
          layout_id: 1,
          size_id: 7,
          angle: 40,
          climb_uuid: id('types'),
        });
        expect(graded).not.toBeNull();
        expect(graded!.boardseshDifficulty).toBe(21.5);
        expect(graded!.boardseshConfidence).toBe('confirmed');

        // No grade row at angle 20 → the flattened fields come back null.
        const ungraded = await getClimbByUuid({
          board_name: 'kilter',
          layout_id: 1,
          size_id: 7,
          angle: 20,
          climb_uuid: id('types'),
        });
        expect(ungraded).not.toBeNull();
        expect(ungraded!.boardseshDifficulty).toBeNull();
        expect(ungraded!.boardseshConfidence).toBeNull();
      });
    });
  });

  // Issue #1971. The stats-driven search INNER JOINs board_climb_stats, so climbs
  // with no stats row at the searched angle are invisible to it. It used to fall
  // back to the unified LEFT JOIN search only on page 0, so a narrow filter went
  // silent past its last stats-having climb — while countClimbs kept counting the
  // stats-less ones, leaving the header count higher than the list and firing
  // "no more climbs" early. This walks a seeded 5-climb result set to exhaustion
  // against real Postgres, so it can't be satisfied by re-deriving the routing rule.
  describe('stats-having boundary pagination (#1971)', () => {
    const PREFIX = 'STATS-BOUNDARY-TEST-';
    const id = (suffix: string) => PREFIX + suffix;
    // Dedicated setter so `settername` narrows the search to exactly these climbs.
    const BOUNDARY_SETTER = 'stats-boundary-setter';

    const boundaryParams: ParsedBoardRouteParameters = {
      board_name: 'kilter',
      layout_id: 1,
      size_id: 7,
      set_ids: [1],
      angle: 40,
    };

    // The order the unified list must come back in under ascents DESC:
    // stats-having by ascensionist_count DESC NULLS LAST, then stats-less by uuid DESC.
    const STATS_HAVING = [id('a-ascents-100'), id('b-ascents-50'), id('c-ascents-null')];
    const STATS_LESS = [id('e-no-stats'), id('d-no-stats')];
    const ALL_SEEDED = [...STATS_HAVING, ...STATS_LESS];

    const boundarySearch = (page: number): ClimbSearchParams => ({
      page,
      pageSize: 2,
      sortBy: 'ascents',
      sortOrder: 'desc',
      settername: [BOUNDARY_SETTER],
    });

    beforeAll(async () => {
      await db.execute(sql`
        INSERT INTO board_climbs (uuid, board_type, layout_id, setter_username, name, frames, frames_count, is_draft, is_listed, edge_left, edge_right, edge_bottom, edge_top, created_at, required_set_ids, compatible_size_ids)
        VALUES
          (${id('a-ascents-100')}, 'kilter', 1, ${BOUNDARY_SETTER}, 'Boundary A', 'p600r12', 1, false, true, 10, 100, 10, 150, '2024-01-01', ARRAY[1], ARRAY[7]),
          (${id('b-ascents-50')}, 'kilter', 1, ${BOUNDARY_SETTER}, 'Boundary B', 'p601r12', 1, false, true, 10, 100, 10, 150, '2024-01-01', ARRAY[1], ARRAY[7]),
          (${id('c-ascents-null')}, 'kilter', 1, ${BOUNDARY_SETTER}, 'Boundary C', 'p602r12', 1, false, true, 10, 100, 10, 150, '2024-01-01', ARRAY[1], ARRAY[7]),
          (${id('d-no-stats')}, 'kilter', 1, ${BOUNDARY_SETTER}, 'Boundary D', 'p603r12', 1, false, true, 10, 100, 10, 150, '2024-01-01', ARRAY[1], ARRAY[7]),
          (${id('e-no-stats')}, 'kilter', 1, ${BOUNDARY_SETTER}, 'Boundary E', 'p604r12', 1, false, true, 10, 100, 10, 150, '2024-01-01', ARRAY[1], ARRAY[7])
        ON CONFLICT DO NOTHING
      `);

      // Only A, B and C have a stats row at angle 40. C's ascensionist_count is NULL
      // so it sits in the NULLS-LAST tail — the exact spot where the fallback's
      // ordering could otherwise interleave it with the stats-less climbs.
      await db.execute(sql`
        INSERT INTO board_climb_stats (board_type, climb_uuid, angle, display_difficulty, ascensionist_count, difficulty_average, quality_average)
        VALUES
          ('kilter', ${id('a-ascents-100')}, 40, 20.0, 100, 20.0, 4.0),
          ('kilter', ${id('b-ascents-50')}, 40, 20.0, 50, 20.0, 3.0),
          ('kilter', ${id('c-ascents-null')}, 40, 20.0, NULL, 20.0, NULL)
        ON CONFLICT DO NOTHING
      `);
    });

    afterAll(async () => {
      await db.execute(sql`DELETE FROM board_climb_stats WHERE climb_uuid LIKE ${PREFIX + '%'}`);
      await db.execute(sql`DELETE FROM board_climbs WHERE uuid LIKE ${PREFIX + '%'}`);
    });

    it('pages past the last stats-having climb instead of stopping there', async () => {
      const collected: string[] = [];
      let pagesWalked = 0;
      let hasMore = true;
      // Bounded so a hasMore that never clears fails loudly instead of hanging.
      while (hasMore && pagesWalked < 10) {
        const result = await searchClimbs(boundaryParams, boundarySearch(pagesWalked));
        collected.push(...result.climbs.map((climb) => climb.uuid));
        hasMore = result.hasMore;
        pagesWalked += 1;
      }

      expect(pagesWalked).toBeLessThan(10);
      // No climb served twice across the stats-having → stats-less boundary.
      expect(new Set(collected).size).toBe(collected.length);
      // Every seeded climb reachable by paging — the regression the issue reports.
      expect([...collected].sort()).toEqual([...ALL_SEEDED].sort());

      // The header badge and the visible list must finally agree.
      const totalCount = await countClimbs(boundaryParams, boundarySearch(0));
      expect(collected.length).toBe(totalCount);

      // Stats-having climbs first, in ascents-DESC order with the NULL count last,
      // then the stats-less climbs by uuid DESC.
      expect(collected.slice(0, STATS_HAVING.length)).toEqual(STATS_HAVING);
      expect(collected.slice(STATS_HAVING.length)).toEqual(STATS_LESS);
    });

    it('keeps stats filters on the stats-driven path (stats-less climbs stay excluded)', async () => {
      // minAscents is a stats predicate, so countClimbs excludes stats-less climbs
      // too — routing this through the fallback would only double the query count
      // without surfacing anything new.
      const statsFiltered: ClimbSearchParams = { ...boundarySearch(0), pageSize: 100, minAscents: 1 };
      const result = await searchClimbs(boundaryParams, statsFiltered);
      const uuids = result.climbs.map((climb) => climb.uuid).filter((uuid) => uuid.startsWith(PREFIX));

      expect(uuids).toEqual([id('a-ascents-100'), id('b-ascents-50')]);
      expect(await countClimbs(boundaryParams, statsFiltered)).toBe(2);
    });
  });

  // Personal rating filters (#2645): "min stars I gave" + "only climbs I rated",
  // read straight off boardsesh_ticks at the browsed angle. Latest rating wins,
  // never-rated climbs stay visible unless onlyRatedByMe is on.
  describe('personal rating filters (#2645)', () => {
    const PREFIX = 'user-rating-';
    const id = (suffix: string) => PREFIX + suffix;
    const USER_ID = 'user-rating-tester';
    const OTHER_USER_ID = 'user-rating-bystander';

    const ratingParams: ParsedBoardRouteParameters = {
      board_name: 'kilter',
      layout_id: 1,
      // Isolated on a size/set key no real catalog climb carries, so the
      // assertions can enumerate the fixtures exactly (same trick as F4 above).
      size_id: 98,
      set_ids: [98],
      angle: 40,
    };

    const search = (overrides: Partial<ClimbSearchParams> = {}): ClimbSearchParams => ({
      page: 0,
      pageSize: 100,
      sortBy: 'creation',
      sortOrder: 'desc',
      ...overrides,
    });

    // Only the seeded climbs — the shared dev DB carries plenty of others at this key.
    const seededUuids = async (searchParams: ClimbSearchParams, userId?: string): Promise<string[]> => {
      const result = await searchClimbs(ratingParams, searchParams, userId);
      return result.climbs
        .map((climb) => climb.uuid)
        .filter((uuid) => uuid.startsWith(PREFIX))
        .sort();
    };

    const ALL_SEEDED = [
      id('rated-5'),
      id('rated-2'),
      id('re-rated-up'),
      id('re-rated-down'),
      id('sent-unrated'),
      id('untouched'),
      id('other-angle'),
      id('other-user'),
    ].sort();

    beforeAll(async () => {
      await db.execute(sql`
        INSERT INTO users (id, email, name, created_at, updated_at)
        VALUES
          (${USER_ID}, ${USER_ID + '@test.com'}, 'Rating Tester', now(), now()),
          (${OTHER_USER_ID}, ${OTHER_USER_ID + '@test.com'}, 'Rating Bystander', now(), now())
        ON CONFLICT (id) DO NOTHING
      `);

      await db.execute(sql`
        INSERT INTO board_climbs (uuid, board_type, layout_id, setter_username, name, frames, frames_count, is_draft, is_listed, edge_left, edge_right, edge_bottom, edge_top, created_at, required_set_ids, compatible_size_ids)
        VALUES
          (${id('rated-5')}, 'kilter', 1, 'ur', 'Rated 5', 'p600r12', 1, false, true, 10, 100, 10, 150, '2024-01-01', ARRAY[98], ARRAY[98]),
          (${id('rated-2')}, 'kilter', 1, 'ur', 'Rated 2', 'p601r12', 1, false, true, 10, 100, 10, 150, '2024-01-01', ARRAY[98], ARRAY[98]),
          (${id('re-rated-up')}, 'kilter', 1, 'ur', 'Re-rated Up', 'p602r12', 1, false, true, 10, 100, 10, 150, '2024-01-01', ARRAY[98], ARRAY[98]),
          (${id('re-rated-down')}, 'kilter', 1, 'ur', 'Re-rated Down', 'p603r12', 1, false, true, 10, 100, 10, 150, '2024-01-01', ARRAY[98], ARRAY[98]),
          (${id('sent-unrated')}, 'kilter', 1, 'ur', 'Sent Unrated', 'p604r12', 1, false, true, 10, 100, 10, 150, '2024-01-01', ARRAY[98], ARRAY[98]),
          (${id('untouched')}, 'kilter', 1, 'ur', 'Untouched', 'p605r12', 1, false, true, 10, 100, 10, 150, '2024-01-01', ARRAY[98], ARRAY[98]),
          (${id('other-angle')}, 'kilter', 1, 'ur', 'Other Angle', 'p606r12', 1, false, true, 10, 100, 10, 150, '2024-01-01', ARRAY[98], ARRAY[98]),
          (${id('other-user')}, 'kilter', 1, 'ur', 'Other User', 'p607r12', 1, false, true, 10, 100, 10, 150, '2024-01-01', ARRAY[98], ARRAY[98])
        ON CONFLICT DO NOTHING
      `);

      // Ratings the filter reads. `re-rated-*` carry two ticks apiece so the
      // latest-wins rule is exercised in both directions.
      await db.execute(sql`
        INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, status, attempt_count, quality, climbed_at)
        VALUES
          (${id('tick-rated-5')}, ${USER_ID}, 'kilter', ${id('rated-5')}, 40, 'send', 1, 5, '2024-03-01'),
          (${id('tick-rated-2')}, ${USER_ID}, 'kilter', ${id('rated-2')}, 40, 'send', 1, 2, '2024-03-01'),
          (${id('tick-up-old')}, ${USER_ID}, 'kilter', ${id('re-rated-up')}, 40, 'send', 1, 2, '2024-01-01'),
          (${id('tick-up-new')}, ${USER_ID}, 'kilter', ${id('re-rated-up')}, 40, 'send', 1, 5, '2024-03-01'),
          (${id('tick-down-old')}, ${USER_ID}, 'kilter', ${id('re-rated-down')}, 40, 'send', 1, 5, '2024-01-01'),
          (${id('tick-down-new')}, ${USER_ID}, 'kilter', ${id('re-rated-down')}, 40, 'send', 1, 2, '2024-03-01'),
          (${id('tick-unrated')}, ${USER_ID}, 'kilter', ${id('sent-unrated')}, 40, 'send', 1, NULL, '2024-03-01'),
          (${id('tick-other-angle')}, ${USER_ID}, 'kilter', ${id('other-angle')}, 20, 'send', 1, 5, '2024-03-01'),
          (${id('tick-other-user')}, ${OTHER_USER_ID}, 'kilter', ${id('other-user')}, 40, 'send', 1, 5, '2024-03-01')
        ON CONFLICT DO NOTHING
      `);
    });

    afterAll(async () => {
      await db.execute(sql`DELETE FROM boardsesh_ticks WHERE uuid LIKE ${PREFIX + '%'}`);
      await db.execute(sql`DELETE FROM board_climbs WHERE uuid LIKE ${PREFIX + '%'}`);
      await db.execute(sql`DELETE FROM users WHERE id IN (${USER_ID}, ${OTHER_USER_ID})`);
    });

    it('seeds every fixture climb when no rating filter is applied', async () => {
      expect(await seededUuids(search(), USER_ID)).toEqual(ALL_SEEDED);
    });

    it('minUserRating keeps unrated climbs and drops only the ones rated below it', async () => {
      const uuids = await seededUuids(search({ minUserRating: 4 }), USER_ID);

      expect(uuids).toEqual(
        [
          id('rated-5'),
          id('re-rated-up'), // 2 → 5: the newer rating wins, so it's back in
          id('sent-unrated'), // ticked but never rated
          id('untouched'),
          id('other-angle'), // rated 5 at 20°, unrated at the browsed 40°
          id('other-user'), // someone else's 5 is not mine
        ].sort(),
      );
      expect(uuids).not.toContain(id('rated-2'));
      expect(uuids).not.toContain(id('re-rated-down')); // 5 → 2: latest rating is below 4
    });

    it('onlyRatedByMe keeps every climb I rated at this angle, whatever the stars', async () => {
      const uuids = await seededUuids(search({ onlyRatedByMe: true }), USER_ID);

      expect(uuids).toEqual([id('rated-5'), id('rated-2'), id('re-rated-up'), id('re-rated-down')].sort());
    });

    it('minUserRating with onlyRatedByMe drops the unrated climbs too', async () => {
      const searchParams = search({ minUserRating: 4, onlyRatedByMe: true });

      expect(await seededUuids(searchParams, USER_ID)).toEqual([id('rated-5'), id('re-rated-up')].sort());
    });

    it('countClimbs agrees with the list for the combined filter', async () => {
      const searchParams = search({ minUserRating: 4, onlyRatedByMe: true });
      const listed = await seededUuids(searchParams, USER_ID);

      // Nothing but the fixtures can match — no other user rates as this test user.
      expect(await countClimbs(ratingParams, searchParams, USER_ID)).toBe(listed.length);
    });

    it('is a no-op without a userId, so an anonymous search stays unfiltered', async () => {
      const searchParams = search({ minUserRating: 5, onlyRatedByMe: true });

      expect(await seededUuids(searchParams)).toEqual(ALL_SEEDED);
    });
  });

  describe('personal grades (#4796 / #4828)', () => {
    const PREFIX = 'my-grade-';
    const id = (suffix: string) => PREFIX + suffix;
    const USER_ID = 'my-grade-tester';
    const OTHER_USER_ID = 'my-grade-bystander';

    // A size/set key no real catalog climb carries, so every assertion can
    // enumerate the fixtures exactly (same trick the rating suite above uses).
    const gradeParams: ParsedBoardRouteParameters = {
      board_name: 'kilter',
      layout_id: 1,
      size_id: 97,
      set_ids: [97],
      angle: 40,
    };

    // The same crowd grade on every fixture, so any difference in filtering or
    // ordering below can only have come from the personal grade.
    const CROWD_GRADE = 16;

    const search = (overrides: Partial<ClimbSearchParams> = {}): ClimbSearchParams => ({
      page: 0,
      pageSize: 100,
      sortBy: 'creation',
      sortOrder: 'desc',
      ...overrides,
    });

    const seededUuids = async (searchParams: ClimbSearchParams, userId?: string): Promise<string[]> => {
      const result = await searchClimbs(gradeParams, searchParams, userId);
      return result.climbs
        .map((climb) => climb.uuid)
        .filter((uuid) => uuid.startsWith(PREFIX))
        .sort();
    };

    const seededOrder = async (searchParams: ClimbSearchParams, userId?: string): Promise<string[]> => {
      const result = await searchClimbs(gradeParams, searchParams, userId);
      return result.climbs.map((climb) => climb.uuid).filter((uuid) => uuid.startsWith(PREFIX));
    };

    const ALL_SEEDED = [
      id('ungraded'),
      id('graded-hard'),
      id('graded-easy'),
      id('regraded-up'),
      id('regraded-down'),
      id('graded-zero'),
      id('over-scale'),
      id('other-angle'),
      id('other-user'),
    ].sort();

    beforeAll(async () => {
      await db.execute(sql`
        INSERT INTO users (id, email, name, created_at, updated_at)
        VALUES
          (${USER_ID}, ${USER_ID + '@test.com'}, 'Grade Tester', now(), now()),
          (${OTHER_USER_ID}, ${OTHER_USER_ID + '@test.com'}, 'Grade Bystander', now(), now())
        ON CONFLICT (id) DO NOTHING
      `);

      await db.execute(sql`
        INSERT INTO board_climbs (uuid, board_type, layout_id, setter_username, name, frames, frames_count, is_draft, is_listed, edge_left, edge_right, edge_bottom, edge_top, created_at, required_set_ids, compatible_size_ids)
        VALUES
          (${id('ungraded')}, 'kilter', 1, 'mg', 'Ungraded', 'p700r12', 1, false, true, 10, 100, 10, 150, '2024-01-09', ARRAY[97], ARRAY[97]),
          (${id('graded-hard')}, 'kilter', 1, 'mg', 'Graded Hard', 'p701r12', 1, false, true, 10, 100, 10, 150, '2024-01-08', ARRAY[97], ARRAY[97]),
          (${id('graded-easy')}, 'kilter', 1, 'mg', 'Graded Easy', 'p702r12', 1, false, true, 10, 100, 10, 150, '2024-01-07', ARRAY[97], ARRAY[97]),
          (${id('regraded-up')}, 'kilter', 1, 'mg', 'Regraded Up', 'p703r12', 1, false, true, 10, 100, 10, 150, '2024-01-06', ARRAY[97], ARRAY[97]),
          (${id('regraded-down')}, 'kilter', 1, 'mg', 'Regraded Down', 'p704r12', 1, false, true, 10, 100, 10, 150, '2024-01-05', ARRAY[97], ARRAY[97]),
          (${id('graded-zero')}, 'kilter', 1, 'mg', 'Graded Zero', 'p705r12', 1, false, true, 10, 100, 10, 150, '2024-01-04', ARRAY[97], ARRAY[97]),
          (${id('over-scale')}, 'kilter', 1, 'mg', 'Over Scale', 'p706r12', 1, false, true, 10, 100, 10, 150, '2024-01-03', ARRAY[97], ARRAY[97]),
          (${id('other-angle')}, 'kilter', 1, 'mg', 'Other Angle', 'p707r12', 1, false, true, 10, 100, 10, 150, '2024-01-02', ARRAY[97], ARRAY[97]),
          (${id('other-user')}, 'kilter', 1, 'mg', 'Other User', 'p708r12', 1, false, true, 10, 100, 10, 150, '2024-01-01', ARRAY[97], ARRAY[97])
        ON CONFLICT DO NOTHING
      `);

      await db.execute(sql`
        INSERT INTO board_climb_stats (climb_uuid, board_type, angle, display_difficulty, difficulty_average, ascensionist_count, quality_average)
        SELECT uuid, 'kilter', 40, ${CROWD_GRADE}, ${CROWD_GRADE}, 5, 3
        FROM board_climbs WHERE uuid LIKE ${PREFIX + '%'}
        ON CONFLICT DO NOTHING
      `);

      // Grades chosen to sit clearly outside the crowd's 16, in both directions.
      await db.execute(sql`
        INSERT INTO boardsesh_ticks (uuid, user_id, board_type, climb_uuid, angle, status, attempt_count, difficulty, climbed_at)
        VALUES
          (${id('t-hard')}, ${USER_ID}, 'kilter', ${id('graded-hard')}, 40, 'send', 1, 27, '2024-03-01'),
          (${id('t-easy')}, ${USER_ID}, 'kilter', ${id('graded-easy')}, 40, 'send', 1, 13, '2024-03-01'),
          (${id('t-up-old')}, ${USER_ID}, 'kilter', ${id('regraded-up')}, 40, 'send', 1, 13, '2024-01-01'),
          (${id('t-up-new')}, ${USER_ID}, 'kilter', ${id('regraded-up')}, 40, 'send', 1, 27, '2024-03-01'),
          (${id('t-down-old')}, ${USER_ID}, 'kilter', ${id('regraded-down')}, 40, 'send', 1, 27, '2024-01-01'),
          (${id('t-down-new')}, ${USER_ID}, 'kilter', ${id('regraded-down')}, 40, 'send', 1, 13, '2024-03-01'),
          (${id('t-zero')}, ${USER_ID}, 'kilter', ${id('graded-zero')}, 40, 'send', 1, 0, '2024-03-01'),
          (${id('t-over')}, ${USER_ID}, 'kilter', ${id('over-scale')}, 40, 'send', 1, 99, '2024-03-01'),
          (${id('t-other-angle')}, ${USER_ID}, 'kilter', ${id('other-angle')}, 20, 'send', 1, 27, '2024-03-01'),
          (${id('t-other-user')}, ${OTHER_USER_ID}, 'kilter', ${id('other-user')}, 40, 'send', 1, 27, '2024-03-01')
        ON CONFLICT DO NOTHING
      `);
    });

    afterAll(async () => {
      await db.execute(sql`DELETE FROM boardsesh_ticks WHERE uuid LIKE ${PREFIX + '%'}`);
      await db.execute(sql`DELETE FROM board_climb_stats WHERE climb_uuid LIKE ${PREFIX + '%'}`);
      await db.execute(sql`DELETE FROM board_climbs WHERE uuid LIKE ${PREFIX + '%'}`);
      await db.execute(sql`DELETE FROM users WHERE id IN (${USER_ID}, ${OTHER_USER_ID})`);
    });

    it('seeds every fixture climb when no grade filter is applied', async () => {
      expect(await seededUuids(search(), USER_ID)).toEqual(ALL_SEEDED);
    });

    it('filters the band on the climber own grade, falling back to the crowd grade', async () => {
      const uuids = await seededUuids(search({ useMyGrades: true, minGrade: 26, maxGrade: 28 }), USER_ID);

      expect(uuids).toEqual(
        [
          id('graded-hard'), // graded 27
          id('regraded-up'), // 13 then 27: the newer grade wins, so it is back in
        ].sort(),
      );

      // The crowd grade is 16 on every fixture, so nothing rides in on it.
      expect(uuids).not.toContain(id('ungraded'));
      expect(uuids).not.toContain(id('graded-easy'));
      // 27 then 13: a MAX(difficulty) implementation passes every other case in
      // this file and fails exactly here.
      expect(uuids).not.toContain(id('regraded-down'));
      expect(uuids).not.toContain(id('graded-zero'));
      // Someone else grading it 27 is not my opinion of it.
      expect(uuids).not.toContain(id('other-user'));
      // Graded 27 at 20 degrees, ungraded at the browsed 40.
      expect(uuids).not.toContain(id('other-angle'));
    });

    it('clamps an out-of-scale grade rather than dropping the climb', async () => {
      // The tick carries 99; the scale tops out at 33 (BOULDER_GRADES), so the
      // climb belongs in the top band, not nowhere.
      const inTopBand = await seededUuids(search({ useMyGrades: true, minGrade: 33, maxGrade: 33 }), USER_ID);
      expect(inTopBand).toContain(id('over-scale'));

      const inRawBand = await seededUuids(search({ useMyGrades: true, minGrade: 99, maxGrade: 99 }), USER_ID);
      expect(inRawBand).not.toContain(id('over-scale'));
    });

    it('treats difficulty 0 as a real grade, not as ungraded', async () => {
      // Clamped to the scale floor (10). Had a falsy check dropped it, the climb
      // would have been filtered by the crowd grade instead and turned up in the
      // crowd-grade band below.
      const atFloor = await seededUuids(search({ useMyGrades: true, minGrade: 10, maxGrade: 10 }), USER_ID);
      expect(atFloor).toContain(id('graded-zero'));

      const atCrowdGrade = await seededUuids(
        search({ useMyGrades: true, minGrade: CROWD_GRADE, maxGrade: CROWD_GRADE }),
        USER_ID,
      );
      expect(atCrowdGrade).not.toContain(id('graded-zero'));
    });

    it('keeps a graded tick at another angle out of this angle answer', async () => {
      const atCrowdGrade = await seededUuids(
        search({ useMyGrades: true, minGrade: CROWD_GRADE, maxGrade: CROWD_GRADE }),
        USER_ID,
      );

      // Graded 27 at 20 degrees — at the browsed 40 the climber has no grade, so
      // the crowd grade is what places it.
      expect(atCrowdGrade).toContain(id('other-angle'));

      const inPersonalBand = await seededUuids(search({ useMyGrades: true, minGrade: 26, maxGrade: 28 }), USER_ID);
      expect(inPersonalBand).not.toContain(id('other-angle'));
    });

    it('sorts on the effective grade, so a re-graded climb lands among the hard ones', async () => {
      const order = await seededOrder(search({ useMyGrades: true, sortBy: 'difficulty', sortOrder: 'desc' }), USER_ID);

      const rank = (uuid: string) => order.indexOf(uuid);
      // 33 and the two 27s outrank every climb sitting on the crowd's grade.
      expect(rank(id('over-scale'))).toBeLessThan(rank(id('ungraded')));
      expect(rank(id('graded-hard'))).toBeLessThan(rank(id('ungraded')));
      expect(rank(id('regraded-up'))).toBeLessThan(rank(id('ungraded')));
      // The climbs graded BELOW the crowd sink under the ungraded ones.
      expect(rank(id('graded-easy'))).toBeGreaterThan(rank(id('ungraded')));
      expect(rank(id('regraded-down'))).toBeGreaterThan(rank(id('ungraded')));
      expect(rank(id('graded-zero'))).toBeGreaterThan(rank(id('graded-easy')));
      // Every fixture is still present: the join is LEFT, so a climb the
      // climber never graded is ordered by the crowd's grade, not dropped.
      expect(order).toHaveLength(ALL_SEEDED.length);
    });

    it('projects myDifficulty on every row so it cannot disagree with its position', async () => {
      const result = await searchClimbs(
        gradeParams,
        search({ useMyGrades: true, sortBy: 'difficulty', sortOrder: 'desc' }),
        USER_ID,
      );
      const byUuid = new Map(result.climbs.map((climb) => [climb.uuid, climb]));

      expect(byUuid.get(id('graded-hard'))?.myDifficulty).toBe(27);
      expect(byUuid.get(id('regraded-down'))?.myDifficulty).toBe(13);
      expect(byUuid.get(id('graded-zero'))?.myDifficulty).toBe(10);
      expect(byUuid.get(id('over-scale'))?.myDifficulty).toBe(33);
      // Never graded at this angle: null, not the crowd's grade.
      expect(byUuid.get(id('ungraded'))?.myDifficulty).toBeNull();
      expect(byUuid.get(id('other-angle'))?.myDifficulty).toBeNull();
      expect(byUuid.get(id('other-user'))?.myDifficulty).toBeNull();
    });

    it('omits myDifficulty entirely when the search did not ask for personal grades', async () => {
      const result = await searchClimbs(gradeParams, search(), USER_ID);
      const row = result.climbs.find((climb) => climb.uuid === id('graded-hard'));

      expect(row).toBeDefined();
      expect('myDifficulty' in row!).toBe(false);
    });

    it('countClimbs agrees with the list, so the badge cannot contradict it', async () => {
      const searchParams = search({ useMyGrades: true, minGrade: 26, maxGrade: 28 });
      const listed = await seededUuids(searchParams, USER_ID);

      // Nothing outside the fixtures shares this size/set key.
      expect(await countClimbs(gradeParams, searchParams, USER_ID)).toBe(listed.length);
    });

    it('agrees with the list on a stats-driven sort too', async () => {
      // sortBy ascents desc routes through the stats-driven INNER JOIN path.
      const searchParams = search({ useMyGrades: true, minGrade: 26, maxGrade: 28, sortBy: 'ascents' });
      const listed = await seededUuids(searchParams, USER_ID);

      expect(listed).toEqual([id('graded-hard'), id('regraded-up')].sort());
      expect(await countClimbs(gradeParams, searchParams, USER_ID)).toBe(listed.length);
    });

    it('falls back to the crowd grade for an anonymous search', async () => {
      // No userId: nobody's ticks to read, so the crowd grade places every
      // fixture and none of them is in the personal band.
      expect(await seededUuids(search({ useMyGrades: true, minGrade: 26, maxGrade: 28 }))).toEqual([]);
      expect(await seededUuids(search({ useMyGrades: true, minGrade: CROWD_GRADE, maxGrade: CROWD_GRADE }))).toEqual(
        ALL_SEEDED,
      );
    });
  });
});
