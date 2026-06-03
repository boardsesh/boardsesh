import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SQL } from 'drizzle-orm';
import {
  createClimbFilters,
  getKilterHomewallWideHoldIdsForSets,
  resetKilterHomewallWideHoldIdsForTests,
} from '../create-climb-filters';
import type { BoardRouteParams, ClimbSearchParams } from '../types';

const params: BoardRouteParams = {
  board_name: 'kilter',
  layout_id: 1,
  size_id: 10,
  set_ids: [1, 20],
  angle: 40,
};

const baseSearch: ClimbSearchParams = {};

/**
 * Flatten a Drizzle SQL fragment into a single inspectable string so tests can
 * assert on the actual SQL produced, not just that *some* condition exists.
 *
 * queryChunks is a mix of:
 *   - { value: ['literal sql'] }
 *   - { name: 'column_name' } (Column/Table instances)
 *   - nested SQL fragments with their own queryChunks
 *   - param markers ({ value: <runtime val> })
 */
function sqlToString<T>(fragment: SQL<T>): string {
  const chunks = (fragment as unknown as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks
    .map((chunk) => {
      if (typeof chunk === 'string' || typeof chunk === 'number' || typeof chunk === 'boolean') {
        return String(chunk);
      }
      if (chunk && typeof chunk === 'object' && 'queryChunks' in chunk) {
        return sqlToString(chunk as SQL);
      }
      if (chunk && typeof chunk === 'object' && 'value' in chunk) {
        const value = (chunk as { value: unknown }).value;
        if (Array.isArray(value)) return value.join('');
        return String(value);
      }
      if (chunk && typeof chunk === 'object' && 'name' in chunk) {
        return String((chunk as { name: unknown }).name);
      }
      return '';
    })
    .join('');
}

void describe('createClimbFilters: projectsOnly', () => {
  void it('produces no projectsOnly condition by default', () => {
    const f = createClimbFilters(params, baseSearch);
    assert.equal(f.projectsOnlyConditions.length, 0);
  });

  void it('emits a COALESCE(ascensionist_count, 0) = 0 condition when projectsOnly is on', () => {
    const f = createClimbFilters(params, { projectsOnly: true });
    assert.equal(f.projectsOnlyConditions.length, 1);
    const rendered = sqlToString(f.projectsOnlyConditions[0]);
    // Match both the column reference and the zero-equality shape so a future
    // refactor that swaps the condition fails the test.
    assert.match(rendered, /COALESCE/i);
    assert.match(rendered, /ascensionist_count/);
    assert.match(rendered, /= 0/);
  });

  void it('adds the projectsOnly condition to the climb WHERE array', () => {
    const baseline = createClimbFilters(params, baseSearch).getClimbWhereConditions();
    const withProjects = createClimbFilters(params, {
      projectsOnly: true,
    }).getClimbWhereConditions();
    assert.equal(withProjects.length, baseline.length + 1);
    // The new entry must be the COALESCE zero-ascents condition.
    const rendered = withProjects.map(sqlToString).join(' || ');
    assert.match(rendered, /COALESCE[^|]*ascensionist_count[^|]*= 0/i);
  });

  void it('skips the minAscents stats condition when projectsOnly is on (prevents contradictory SQL)', () => {
    const f = createClimbFilters(params, { projectsOnly: true, minAscents: 10 });
    // No stats condition should reference ascensionist_count >= 10 when projectsOnly is on.
    const rendered = f.climbStatsConditions.map(sqlToString).join(' || ');
    assert.doesNotMatch(rendered, /ascensionist_count/);
  });

  void it('emits ascensionist_count >= N when projectsOnly is off and minAscents is set', () => {
    const f = createClimbFilters(params, { projectsOnly: false, minAscents: 10 });
    assert.equal(f.climbStatsConditions.length, 1);
    const rendered = sqlToString(f.climbStatsConditions[0]);
    assert.match(rendered, /ascensionist_count/);
    // Drizzle's gte renders as "... >= $param"; the literal operator is enough
    // to confirm we're asserting on the comparison, not some unrelated predicate.
    assert.match(rendered, />=/);
  });

  void it('keeps stats conditions empty so the stats-driven INNER JOIN path is not selected by projectsOnly alone', () => {
    // search-climbs uses climbStatsConditions.length > 0 to pick the INNER JOIN
    // fast path. projectsOnly must live outside climbStatsConditions so climbs
    // with no stats row are not dropped by the INNER JOIN.
    const f = createClimbFilters(params, { projectsOnly: true });
    assert.equal(f.climbStatsConditions.length, 0);
  });
});

void describe('createClimbFilters: minRating', () => {
  const ratingScaleCases: Array<{ minRating: number; expectedThreshold: string }> = [
    { minRating: 1, expectedThreshold: '0.2' },
    { minRating: 4, expectedThreshold: '0.8' },
    { minRating: 5, expectedThreshold: '1' },
  ];

  for (const { minRating, expectedThreshold } of ratingScaleCases) {
    void it(`scales minRating ${minRating} to stored threshold ${expectedThreshold}`, () => {
      const filters = createClimbFilters(params, { minRating });
      assert.equal(filters.climbStatsConditions.length, 1);

      const rendered = sqlToString(filters.climbStatsConditions[0]);
      assert.match(rendered, /quality_average/);
      assert.match(rendered, />=/);
      assert.match(rendered, new RegExp(`>=\\s*${expectedThreshold}`));
      assert.doesNotMatch(rendered, new RegExp(`>=\\s*${minRating}(?:\\D|$)`));
    });
  }

  void it('does not append a rating filter when minRating is 0', () => {
    const filters = createClimbFilters(params, { minRating: 0 });
    assert.equal(filters.climbStatsConditions.length, 0);
  });

  void it('does not append a rating filter when minRating is undefined', () => {
    const filters = createClimbFilters(params, {});
    assert.equal(filters.climbStatsConditions.length, 0);
  });
});

void describe('createClimbFilters: zone modes', () => {
  const zoneBox = { edgeLeft: 10, edgeRight: 80, edgeBottom: 20, edgeTop: 120 };

  void it('defaults to all-holds containment using board_climbs edge columns', () => {
    const filters = createClimbFilters(params, { zoneBox });

    assert.equal(filters.zoneConditions.length, 4);
    const rendered = filters.zoneConditions.map(sqlToString).join(' && ');
    assert.match(rendered, /edge_left/);
    assert.match(rendered, /edge_right/);
    assert.match(rendered, /edge_bottom/);
    assert.match(rendered, /edge_top/);
    assert.doesNotMatch(rendered, /board_climb_holds/);
  });

  void it('uses an individual-hold EXISTS predicate for anyHold mode', () => {
    const filters = createClimbFilters(params, { zoneBox, zoneMode: 'anyHold' });

    assert.equal(filters.zoneConditions.length, 1);
    const rendered = sqlToString(filters.zoneConditions[0]);
    assert.match(rendered, /EXISTS/);
    assert.match(rendered, /FROM\s+zone_ch/);
    assert.match(rendered, /JOIN\s+zone_bp/);
    assert.match(rendered, /JOIN\s+.*zone_bh/);
    assert.match(rendered, /zone_bp\.set_id IN \(1, 20\)/);
    assert.match(rendered, /zone_bh\.x\s*>?=/);
    assert.match(rendered, /zone_bh\.y\s*>?=/);
  });

  void it('uses anyHold zones on MoonBoard without set membership predicates', () => {
    const filters = createClimbFilters(
      { board_name: 'moonboard', layout_id: 1, size_id: 1, set_ids: [], angle: 40 },
      { zoneBox, zoneMode: 'anyHold' },
    );

    assert.equal(filters.zoneConditions.length, 1);
    const rendered = sqlToString(filters.zoneConditions[0]);
    assert.match(rendered, /EXISTS/);
    assert.match(rendered, /JOIN\s+zone_bp/);
    assert.doesNotMatch(rendered, /zone_bp\.set_id IN/);
  });

  void it('omits the set membership predicate for anyHold when non-MoonBoard set_ids are empty', () => {
    const filters = createClimbFilters({ ...params, set_ids: [] }, { zoneBox, zoneMode: 'anyHold' });

    assert.equal(filters.zoneConditions.length, 1);
    const rendered = sqlToString(filters.zoneConditions[0]);
    assert.match(rendered, /EXISTS/);
    assert.match(rendered, /JOIN\s+zone_bp/);
    assert.doesNotMatch(rendered, /zone_bp\.set_id IN/);
  });

  void it('ignores zoneMode when the zone box is empty or inverted', () => {
    const filters = createClimbFilters(params, {
      zoneBox: { edgeLeft: 80, edgeRight: 10, edgeBottom: 20, edgeTop: 120 },
      zoneMode: 'anyHold',
    });

    assert.equal(filters.zoneConditions.length, 0);
  });
});

void describe('createClimbFilters: tall climbs', () => {
  const homewallTallParams: BoardRouteParams = {
    board_name: 'kilter',
    layout_id: 8,
    size_id: 25,
    set_ids: [26, 27, 28, 29],
    angle: 40,
  };

  void it('uses the climb bottom edge to find Kilter Homewall tall climbs', () => {
    const filters = createClimbFilters(homewallTallParams, { onlyTallClimbs: true });

    assert.equal(filters.tallClimbsConditions.length, 1);
    const rendered = sqlToString(filters.tallClimbsConditions[0]);
    assert.match(rendered, /edge_bottom/);
    assert.match(rendered, /SELECT MAX\(ps\.edge_bottom\)/);
    assert.match(rendered, /FROM/);
    assert.match(rendered, /MAX/);
    assert.match(rendered, /product_id/);
  });

  void it('supports tall climbs on 8x12 Kilter Homewall sizes', () => {
    for (const sizeId of [23, 24]) {
      const filters = createClimbFilters({ ...homewallTallParams, size_id: sizeId }, { onlyTallClimbs: true });
      assert.equal(filters.tallClimbsConditions.length, 1);
      assert.notEqual(sqlToString(filters.tallClimbsConditions[0]), 'false');
      assert.match(sqlToString(filters.tallClimbsConditions[0]), /edge_bottom/);
    }
  });

  void it('returns no results for tall climbs requests on unsupported boards or sizes', () => {
    const unsupportedCases = [
      { ...homewallTallParams, size_id: 21 },
      { ...homewallTallParams, layout_id: 1 },
      { ...homewallTallParams, board_name: 'tension' as const },
    ];

    for (const unsupportedParams of unsupportedCases) {
      const filters = createClimbFilters(unsupportedParams, { onlyTallClimbs: true });
      assert.equal(filters.tallClimbsConditions.length, 1);
      assert.equal(sqlToString(filters.tallClimbsConditions[0]), 'false');
    }
  });
});

void describe('createClimbFilters: wide climbs', () => {
  const homewallWideParams: BoardRouteParams = {
    board_name: 'kilter',
    layout_id: 8,
    size_id: 25,
    set_ids: [26, 27, 28, 29],
    angle: 40,
  };

  void it('does not add a wide climbs predicate when the filter is off', () => {
    const filters = createClimbFilters(homewallWideParams, {});

    assert.equal(filters.wideClimbsConditions.length, 0);
  });

  void it('uses an individual-hold EXISTS predicate for 10x10 side expansion holds', () => {
    const filters = createClimbFilters(homewallWideParams, { onlyWideClimbs: true });

    assert.equal(filters.wideClimbsConditions.length, 1);
    const rendered = sqlToString(filters.wideClimbsConditions[0]);
    const wideHoldIds = getKilterHomewallWideHoldIdsForSets(homewallWideParams.set_ids);

    assert.equal(wideHoldIds.length, 86);
    assert.match(rendered, /EXISTS/);
    assert.match(rendered, /FROM\s+wide_ch/);
    assert.match(rendered, /wide_ch\.hold_id IN/);
    assert.match(rendered, new RegExp(String(wideHoldIds[0])));
    assert.match(rendered, new RegExp(String(wideHoldIds[wideHoldIds.length - 1])));
    assert.doesNotMatch(rendered, /JOIN\s+wide_bp/);
    assert.doesNotMatch(rendered, /JOIN\s+.*wide_bh/);
    assert.doesNotMatch(rendered, /board_product_sizes/);
    assert.doesNotMatch(rendered, /wide_ps/);
    assert.doesNotMatch(rendered, /small_ps/);
    assert.doesNotMatch(rendered, /compatible_size_ids/);
  });

  void it('can reset cached wide hold metadata for test isolation', () => {
    const beforeReset = getKilterHomewallWideHoldIdsForSets([26, 27]);
    resetKilterHomewallWideHoldIdsForTests();
    const afterReset = getKilterHomewallWideHoldIdsForSets([26, 27]);

    assert.deepEqual(afterReset, beforeReset);
  });

  void it('narrows the wide hold list to selected route sets', () => {
    const filters = createClimbFilters({ ...homewallWideParams, set_ids: [26] }, { onlyWideClimbs: true });

    assert.equal(filters.wideClimbsConditions.length, 1);
    const rendered = sqlToString(filters.wideClimbsConditions[0]);
    const mainlineWideHoldIds = getKilterHomewallWideHoldIdsForSets([26]);
    const auxiliaryWideHoldIds = getKilterHomewallWideHoldIdsForSets([27]);

    assert.equal(mainlineWideHoldIds.length, 30);
    assert.equal(auxiliaryWideHoldIds.length, 56);
    assert.match(rendered, new RegExp(String(mainlineWideHoldIds[0])));
    assert.match(rendered, new RegExp(String(mainlineWideHoldIds[mainlineWideHoldIds.length - 1])));
    assert.doesNotMatch(rendered, new RegExp(String(auxiliaryWideHoldIds[0])));
  });

  void it('keeps wide filtering active when selected sets mix expansion and non-expansion sets', () => {
    const filters = createClimbFilters({ ...homewallWideParams, set_ids: [26, 28] }, { onlyWideClimbs: true });

    assert.equal(filters.wideClimbsConditions.length, 1);
    const rendered = sqlToString(filters.wideClimbsConditions[0]);
    const mixedWideHoldIds = getKilterHomewallWideHoldIdsForSets([26, 28]);

    assert.equal(mixedWideHoldIds.length, 30);
    assert.notEqual(rendered, 'false');
    assert.match(rendered, /wide_ch\.hold_id IN/);
    assert.match(rendered, new RegExp(String(mixedWideHoldIds[0])));
  });

  void it('uses a false condition when selected sets contain no side expansion holds', () => {
    const filters = createClimbFilters({ ...homewallWideParams, set_ids: [28, 29] }, { onlyWideClimbs: true });

    assert.equal(filters.wideClimbsConditions.length, 1);
    assert.equal(sqlToString(filters.wideClimbsConditions[0]), 'false');
  });

  void it('returns no results for wide climbs requests on unsupported boards or sizes', () => {
    const unsupportedCases = [
      { ...homewallWideParams, size_id: 17 },
      { ...homewallWideParams, layout_id: 1 },
      { ...homewallWideParams, board_name: 'tension' as const },
    ];

    for (const unsupportedParams of unsupportedCases) {
      const filters = createClimbFilters(unsupportedParams, { onlyWideClimbs: true });
      assert.equal(filters.wideClimbsConditions.length, 1);
      assert.equal(sqlToString(filters.wideClimbsConditions[0]), 'false');
    }
  });

  void it('applies wide climbs filtering to the 10x10 Auxiliary LED Kit size', () => {
    const filters = createClimbFilters({ ...homewallWideParams, size_id: 29, set_ids: [27] }, { onlyWideClimbs: true });

    assert.equal(filters.wideClimbsConditions.length, 1);
    assert.match(sqlToString(filters.wideClimbsConditions[0]), /EXISTS/);
  });

  void it('can combine tall and wide filters on 10x12 Kilter Homewall', () => {
    const filters = createClimbFilters(homewallWideParams, { onlyTallClimbs: true, onlyWideClimbs: true });

    assert.equal(filters.tallClimbsConditions.length, 1);
    assert.equal(filters.wideClimbsConditions.length, 1);
  });
});

void describe('createClimbFilters: beta videos', () => {
  const params: BoardRouteParams = {
    board_name: 'kilter',
    layout_id: 8,
    size_id: 25,
    set_ids: [26, 27, 28, 29],
    angle: 40,
  };

  void it('does not add a beta-videos predicate when the filter is off', () => {
    const filters = createClimbFilters(params, {});

    assert.equal(filters.betaVideosConditions.length, 0);
  });

  void it('adds an EXISTS predicate over visible beta links when enabled', () => {
    const filters = createClimbFilters(params, { onlyWithBetaVideos: true });

    assert.equal(filters.betaVideosConditions.length, 1);
    const rendered = sqlToString(filters.betaVideosConditions[0]);
    assert.match(rendered, /EXISTS/);
    assert.match(rendered, /bl\.board_type = kilter/);
    assert.match(rendered, /bl\.climb_uuid = uuid/);
    // Visible links are is_listed true or NULL — explicitly hidden links excluded.
    assert.match(rendered, /bl\.is_listed IS NOT FALSE/);
  });

  void it('applies on non-Kilter boards too — it is not size-gated', () => {
    const filters = createClimbFilters(
      { ...params, board_name: 'tension', layout_id: 1, size_id: 7 },
      { onlyWithBetaVideos: true },
    );

    assert.equal(filters.betaVideosConditions.length, 1);
    const rendered = sqlToString(filters.betaVideosConditions[0]);
    assert.notEqual(rendered, 'false');
    assert.match(rendered, /EXISTS/);
    assert.match(rendered, /bl\.board_type = tension/);
  });
});

void describe('createClimbFilters: personal progress filters are scoped to the current angle', () => {
  // Locks in the angle-scoping contract — a send at one angle must not leak
  // into hide/show filters at a different angle. Each filter renders a
  // (NOT) EXISTS subquery against boardsesh_ticks that must restrict by
  // the `angle` column.
  const userId = 'user-abc';
  const angleParams: BoardRouteParams = { ...params, angle: 50 };

  function progressSql(searchParams: ClimbSearchParams): string {
    const f = createClimbFilters(angleParams, searchParams, userId);
    return f.personalProgressConditions.map(sqlToString).join(' && ');
  }

  void it('emits exactly one progress condition per active filter', () => {
    const f = createClimbFilters(angleParams, { hideCompleted: true }, userId);
    assert.equal(f.personalProgressConditions.length, 1);
  });

  void it('hideCompleted is a NOT EXISTS subquery scoped to the angle column', () => {
    const sql = progressSql({ hideCompleted: true });
    assert.match(sql, /NOT EXISTS/);
    assert.match(sql, /angle\s*=/);
    // Sanity: targets completions (flash/send), not attempts.
    assert.match(sql, /'flash'.*'send'/);
    assert.doesNotMatch(sql, /'attempt'/);
  });

  void it('hideAttempted is a NOT EXISTS subquery scoped to the angle column', () => {
    const sql = progressSql({ hideAttempted: true });
    assert.match(sql, /NOT EXISTS/);
    assert.match(sql, /angle\s*=/);
    assert.match(sql, /'attempt'/);
  });

  void it('showOnlyCompleted is a positive EXISTS subquery scoped to the angle column', () => {
    const sql = progressSql({ showOnlyCompleted: true });
    assert.match(sql, /EXISTS/);
    assert.doesNotMatch(sql, /NOT EXISTS/);
    assert.match(sql, /angle\s*=/);
    assert.match(sql, /'flash'.*'send'/);
  });

  void it('showOnlyAttempted is a positive EXISTS subquery scoped to the angle column', () => {
    const sql = progressSql({ showOnlyAttempted: true });
    assert.match(sql, /EXISTS/);
    assert.doesNotMatch(sql, /NOT EXISTS/);
    assert.match(sql, /angle\s*=/);
    assert.match(sql, /'attempt'/);
  });

  void it('skips personal progress conditions entirely when no userId is supplied', () => {
    const f = createClimbFilters(angleParams, { hideCompleted: true });
    assert.equal(f.personalProgressConditions.length, 0);
  });

  void it('per-climb userAscents/userAttempts selectors are scoped to the angle column', () => {
    const f = createClimbFilters(angleParams, baseSearch, userId);
    const selects = f.getUserLogbookSelects();
    const ascentsSql = sqlToString(selects.userAscents);
    const attemptsSql = sqlToString(selects.userAttempts);
    assert.match(ascentsSql, /angle\s*=/);
    assert.match(attemptsSql, /angle\s*=/);
    // And the status sets must still match the semantic of each selector.
    assert.match(ascentsSql, /'flash'.*'send'/);
    assert.match(attemptsSql, /'attempt'/);
  });
});

void describe('createClimbFilters: onlyBenchmarks', () => {
  void it('produces no benchmark condition by default', () => {
    const f = createClimbFilters(params, baseSearch);
    assert.equal(f.climbStatsConditions.length, 0);
  });

  void it('emits a benchmark_difficulty IS NOT NULL stats condition when onlyBenchmarks is on', () => {
    const f = createClimbFilters(params, { onlyBenchmarks: true });
    assert.equal(f.climbStatsConditions.length, 1);
    const rendered = sqlToString(f.climbStatsConditions[0]);
    assert.match(rendered, /benchmark_difficulty/);
    assert.match(rendered, /IS NOT NULL/i);
  });
});
