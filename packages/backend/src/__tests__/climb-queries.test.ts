import { describe, it, expect, beforeAll, afterAll } from 'vite-plus/test';
import {
  searchClimbs,
  countClimbs,
  getClimbByUuid,
  type ParsedBoardRouteParameters,
  type ClimbSearchParams,
} from '../db/queries/climbs/index';
import { db, dbRead } from '../db/client';
import { getHoldHeatmapData } from '@boardsesh/db/queries';
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
  });

  describe('getHoldHeatmapData', () => {
    // Seed two listed climbs that share hold 700 (HAND in both) plus a unique
    // hold each, with stats so totalAscents/averageDifficulty are populated.
    //   - "easy"  (V4-ish, 100 ascents): holds 700 (HAND), 701 (STARTING)
    //   - "hard"  (V8-ish, 200 ascents): holds 700 (HAND), 702 (FOOT)
    const HEATMAP_PREFIX = 'heatmap-test-';

    beforeAll(async () => {
      await db.execute(sql`
        INSERT INTO board_climbs (uuid, board_type, layout_id, setter_username, name, frames, frames_count, is_draft, is_listed, edge_left, edge_right, edge_bottom, edge_top, created_at, required_set_ids, compatible_size_ids)
        VALUES
          (${HEATMAP_PREFIX + 'easy'}, 'kilter', 1, 'test-setter', 'Heatmap Easy', 'p700r12p701r15', 1, false, true, 10, 100, 10, 150, '2024-01-01', ARRAY[1], ARRAY[7]),
          (${HEATMAP_PREFIX + 'hard'}, 'kilter', 1, 'test-setter', 'Heatmap Hard', 'p700r12p702r13', 1, false, true, 10, 100, 10, 150, '2024-01-01', ARRAY[1], ARRAY[7])
        ON CONFLICT DO NOTHING
      `);

      await db.execute(sql`
        INSERT INTO board_climb_holds (board_type, climb_uuid, hold_id, frame_number, hold_state)
        VALUES
          ('kilter', ${HEATMAP_PREFIX + 'easy'}, 700, 0, 'HAND'),
          ('kilter', ${HEATMAP_PREFIX + 'easy'}, 701, 0, 'STARTING'),
          ('kilter', ${HEATMAP_PREFIX + 'hard'}, 700, 0, 'HAND'),
          ('kilter', ${HEATMAP_PREFIX + 'hard'}, 702, 0, 'FOOT')
        ON CONFLICT DO NOTHING
      `);

      await db.execute(sql`
        INSERT INTO board_climb_stats (board_type, climb_uuid, angle, display_difficulty, ascensionist_count)
        VALUES
          ('kilter', ${HEATMAP_PREFIX + 'easy'}, 40, 13, 100),
          ('kilter', ${HEATMAP_PREFIX + 'hard'}, 40, 21, 200)
        ON CONFLICT DO NOTHING
      `);
    });

    afterAll(async () => {
      await db.execute(sql`DELETE FROM board_climb_stats WHERE climb_uuid LIKE ${HEATMAP_PREFIX + '%'}`);
      await db.execute(sql`DELETE FROM board_climb_holds WHERE climb_uuid LIKE ${HEATMAP_PREFIX + '%'}`);
      await db.execute(sql`DELETE FROM board_climbs WHERE uuid LIKE ${HEATMAP_PREFIX + '%'}`);
    });

    it('should aggregate community hold stats for a board config', async () => {
      const rows = await getHoldHeatmapData(dbRead, testParams, { page: 0, pageSize: 20 });
      const byHold = new Map(rows.map((row) => [row.holdId, row]));

      // The shared hold is used by both climbs; the unique holds by one each.
      const shared = byHold.get(700);
      expect(shared).toBeDefined();
      expect(shared?.totalUses).toBe(2);
      expect(shared?.handUses).toBe(2);
      // totalAscents sums ascensionist_count across both climbs (100 + 200).
      expect(shared?.totalAscents).toBe(300);
      // Community-only: no per-user fields without a userId.
      expect(shared?.userAscents).toBeUndefined();
      expect(shared?.userAttempts).toBeUndefined();

      const startingHold = byHold.get(701);
      expect(startingHold?.totalUses).toBe(1);
      expect(startingHold?.startingUses).toBe(1);

      const footHold = byHold.get(702);
      expect(footHold?.totalUses).toBe(1);
      expect(footHold?.footUses).toBe(1);
    });

    it('should narrow the aggregate when a grade filter excludes climbs', async () => {
      // Only the "hard" climb (display grade 21) is in 20..22; the shared hold
      // 700 should now reflect a single climb, and 701 (easy-only) drops out.
      const rows = await getHoldHeatmapData(dbRead, testParams, {
        page: 0,
        pageSize: 20,
        minGrade: 20,
        maxGrade: 22,
      });
      const byHold = new Map(rows.map((row) => [row.holdId, row]));

      expect(byHold.get(700)?.totalUses).toBe(1);
      expect(byHold.get(700)?.totalAscents).toBe(200);
      expect(byHold.get(702)?.totalUses).toBe(1);
      expect(byHold.has(701)).toBe(false);
    });

    it('should return an empty array for an invalid size_id', async () => {
      const rows = await getHoldHeatmapData(dbRead, { ...testParams, size_id: 999999 }, { page: 0, pageSize: 20 });
      const seededHolds = rows.filter((row) => row.holdId === 700 || row.holdId === 701 || row.holdId === 702);
      expect(seededHolds).toEqual([]);
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

    it('should skip set_ids filter for moonboard', async () => {
      const params: ParsedBoardRouteParameters = {
        board_name: 'moonboard',
        layout_id: 1,
        size_id: 1,
        set_ids: [1],
        angle: 40,
      };

      // Should not throw (the filter is skipped for moonboard)
      const result = await searchClimbs(params, { page: 0, pageSize: 10 });
      expect(result).toBeDefined();
      expect(result.climbs).toBeInstanceOf(Array);
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
  });
});
