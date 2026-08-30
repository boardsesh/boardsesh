import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SQL } from 'drizzle-orm';
import { woodsHoldIdsInZone } from '@boardsesh/board-config';
import { createClimbFilters } from '../create-climb-filters';
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

void describe('createClimbFilters: size filter', () => {
  void it('uses array containment so the compatible_size_ids GIN index can support the predicate', () => {
    const filters = createClimbFilters(params, baseSearch);
    assert.equal(filters.sizeConditions.length, 1);

    const rendered = sqlToString(filters.sizeConditions[0]);
    assert.match(rendered, /compatible_size_ids/);
    assert.match(rendered, /@>/);
    assert.match(rendered, /ARRAY\[/);
    assert.match(rendered, /::int\[\]/);
  });

  void it('omits size filtering for MoonBoard', () => {
    const filters = createClimbFilters({ ...params, board_name: 'moonboard', size_id: 1, set_ids: [] }, baseSearch);

    assert.equal(filters.sizeConditions.length, 0);
  });
});

void describe('createClimbFilters: minRating', () => {
  // quality_average is the canonical 1-5 scale, so minRating (1-5 whole stars) is
  // compared directly. The old code divided by 5 (assuming a dead 0-1 scale), which
  // made the filter a near no-op — these cases guard against that regression.
  for (const minRating of [1, 4, 5]) {
    void it(`compares minRating ${minRating} directly against quality_average (1-5 scale)`, () => {
      const filters = createClimbFilters(params, { minRating });
      assert.equal(filters.climbStatsConditions.length, 1);

      const rendered = sqlToString(filters.climbStatsConditions[0]);
      assert.match(rendered, /quality_average/);
      assert.match(rendered, new RegExp(`>=\\s*${minRating}(?:\\D|$)`));
      // Must NOT divide by 5 anymore (old 0-1-scale threshold).
      assert.doesNotMatch(rendered, new RegExp(`>=\\s*${minRating / 5}(?:\\D|$)`));
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
    assert.match(rendered, /zone_bp\.id\s*=\s*zone_ch\.hold_id/);
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
    assert.match(rendered, /zone_bp\.hole_id\s*=\s*zone_ch\.hold_id/);
    assert.match(rendered, /MOD\(\(zone_bp\.hole_id - 1\), 11\)/);
    assert.match(rendered, /1\.1 \+/);
    // Loose on the trailing digits: the vertical origin is computed in floating
    // point (18 * 0.94 renders as 16.919999999999998), so pinning it exactly
    // asserts the formatter rather than the calibration.
    assert.match(rendered, /16\.9\d* -/);
    assert.doesNotMatch(rendered, /zone_bh\.x\s*>?=/);
    assert.doesNotMatch(rendered, /zone_bh\.y\s*>?=/);
    assert.doesNotMatch(rendered, /zone_bp\.set_id IN/);
  });

  void it('uses Mini MoonBoard calibration for Mini anyHold zones', () => {
    const filters = createClimbFilters(
      { board_name: 'moonboard', layout_id: 6, size_id: 1, set_ids: [], angle: 40 },
      { zoneBox, zoneMode: 'anyHold' },
    );

    const rendered = sqlToString(filters.zoneConditions[0]);
    assert.match(rendered, /1\.1517 \+/);
    assert.match(rendered, /11\.04\d* -/);
    assert.match(rendered, /12 - \(FLOOR/);
  });

  void it('uses calibrated placement containment for MoonBoard allHolds zones', () => {
    const filters = createClimbFilters(
      { board_name: 'moonboard', layout_id: 1, size_id: 1, set_ids: [], angle: 40 },
      { zoneBox },
    );

    assert.equal(filters.zoneConditions.length, 2);
    const rendered = filters.zoneConditions.map(sqlToString).join(' AND ');
    assert.match(rendered, /EXISTS/);
    assert.match(rendered, /NOT EXISTS/);
    assert.match(rendered, /contained_bp\.hole_id\s*=\s*contained_ch\.hold_id/);
    assert.match(rendered, /MOD\(\(contained_bp\.hole_id - 1\), 11\)/);
    assert.doesNotMatch(rendered, /edge_left/);
    assert.doesNotMatch(rendered, /edge_right/);
    assert.doesNotMatch(rendered, /edge_bottom/);
    assert.doesNotMatch(rendered, /edge_top/);
  });

  void it('omits the set membership predicate for anyHold when non-MoonBoard set_ids are empty', () => {
    const filters = createClimbFilters({ ...params, set_ids: [] }, { zoneBox, zoneMode: 'anyHold' });

    assert.equal(filters.zoneConditions.length, 1);
    const rendered = sqlToString(filters.zoneConditions[0]);
    assert.match(rendered, /EXISTS/);
    assert.match(rendered, /JOIN\s+zone_bp/);
    assert.doesNotMatch(rendered, /zone_bp\.set_id IN/);
  });

  void it('fails closed when a requested zone box is inverted or empty', () => {
    const filters = createClimbFilters(params, {
      zoneBox: { edgeLeft: 80, edgeRight: 10, edgeBottom: 20, edgeTop: 120 },
      zoneMode: 'anyHold',
    });

    // A requested-but-degenerate box must not return every climb — it fails closed
    // (single `false` predicate), matching the tall/wide filters.
    assert.equal(filters.zoneConditions.length, 1);
    assert.match(sqlToString(filters.zoneConditions[0]), /false/i);
  });

  void it('adds no zone predicate when no zone box is requested', () => {
    const filters = createClimbFilters(params, { zoneMode: 'anyHold' });
    assert.equal(filters.zoneConditions.length, 0);
  });
});

// Woods has no `board_placements` / `board_holes` rows and no denormalized
// `edge_*` on its climbs, so neither of the paths above can answer a region box
// for it (boardsesh/boardsesh#4748). Its holds are resolved against the box in
// TypeScript and the query filters on hold ids instead.
void describe('createClimbFilters: Woods zone modes', () => {
  // 8x10 = size id 1, a 21-column x 25-row edge box. The lower-left quarter.
  const woodsParams = { board_name: 'woods' as const, layout_id: 1, size_id: 1, set_ids: [1], angle: 40 };
  const zoneBox = { edgeLeft: 0, edgeRight: 10, edgeBottom: 0, edgeTop: 12 };

  void it('matches allHolds by rejecting any hold outside the box', () => {
    const filters = createClimbFilters(woodsParams, { zoneBox });

    assert.equal(filters.zoneConditions.length, 2);
    const rendered = filters.zoneConditions.map(sqlToString).join(' && ');
    // A climb must have holds, and none of them may fall outside the box.
    assert.match(rendered, /EXISTS/);
    assert.match(rendered, /NOT EXISTS/);
    assert.match(rendered, /AND NOT \(zone_ch\.hold_id = ANY\(ARRAY\[/);
    // No placement bridge, and no reliance on the NULL edge columns.
    assert.doesNotMatch(rendered, /board_placements/);
    assert.doesNotMatch(rendered, /board_holes/);
    assert.doesNotMatch(rendered, /edge_left/);
  });

  void it('filters on exactly the hold ids the shared geometry puts inside the box', () => {
    const filters = createClimbFilters(woodsParams, { zoneBox, zoneMode: 'anyHold' });
    const rendered = sqlToString(filters.zoneConditions[0]);
    const holdIds = woodsHoldIdsInZone(woodsParams.size_id, zoneBox)!;

    // Read the ids back off the rendered ARRAY[...] literal rather than restating
    // the geometry here — the point is that the query and the picker agree.
    const renderedIds = rendered
      .slice(rendered.indexOf('ARRAY[') + 'ARRAY['.length, rendered.indexOf(']::int[]'))
      .split(',')
      .map((value) => Number(value.trim()));
    assert.ok(holdIds.length > 0);
    assert.deepEqual(renderedIds, holdIds);
  });

  void it('matches anyHold with a single EXISTS over the holds inside the box', () => {
    const filters = createClimbFilters(woodsParams, { zoneBox, zoneMode: 'anyHold' });

    assert.equal(filters.zoneConditions.length, 1);
    const rendered = sqlToString(filters.zoneConditions[0]);
    assert.match(rendered, /EXISTS/);
    assert.doesNotMatch(rendered, /NOT EXISTS/);
    assert.match(rendered, /zone_ch\.hold_id = ANY\(ARRAY\[/);
    assert.doesNotMatch(rendered, /board_placements/);
  });

  void it('selects different holds for the two board sizes', () => {
    const smallBoard = createClimbFilters(woodsParams, { zoneBox, zoneMode: 'anyHold' });
    const largeBoard = createClimbFilters({ ...woodsParams, size_id: 2 }, { zoneBox, zoneMode: 'anyHold' });

    assert.notEqual(sqlToString(smallBoard.zoneConditions[0]), sqlToString(largeBoard.zoneConditions[0]));
  });

  void it('fails closed on a box that covers no hold', () => {
    const filters = createClimbFilters(woodsParams, {
      zoneBox: { edgeLeft: 0, edgeRight: 1, edgeBottom: 0, edgeTop: 1 },
      zoneMode: 'anyHold',
    });

    assert.equal(filters.zoneConditions.length, 1);
    assert.match(sqlToString(filters.zoneConditions[0]), /false/i);
  });

  void it('fails closed on a size id that is not a Woods board', () => {
    const filters = createClimbFilters({ ...woodsParams, size_id: 99 }, { zoneBox });

    assert.equal(filters.zoneConditions.length, 1);
    assert.match(sqlToString(filters.zoneConditions[0]), /false/i);
  });
});

// `baseHoldLocation` is 0-based on Woods, so the hold-key parser can't reject
// non-positive ids the way it did — hold 0 is the first hold of every Woods board.
void describe('createClimbFilters: hold keys', () => {
  void it('keeps hold id 0', () => {
    const filters = createClimbFilters(params, { holdsFilter: { '0': { ANY: 'include' } } });

    assert.deepEqual(filters.anyHolds, [0]);
    assert.match(sqlToString(filters.holdConditions[0]), /frames like %p0r%/i);
  });

  void it('keeps hold id 0 behind the hold_ prefix, and in a state filter', () => {
    const filters = createClimbFilters(params, { holdsFilter: { hold_0: { HAND: 'include' } } });

    assert.deepEqual(filters.holdStateFilters, [{ holdId: 0, state: 'HAND', mode: 'include' }]);
  });

  void it('still drops keys that are not a hold number', () => {
    const filters = createClimbFilters(params, {
      holdsFilter: {
        hold_: { ANY: 'include' },
        'hold_-1': { ANY: 'include' },
        'hold_1.5': { ANY: 'include' },
        hold_red: { ANY: 'include' },
        '': { ANY: 'include' },
      },
    });

    assert.deepEqual(filters.anyHolds, []);
    assert.equal(filters.holdConditions.length, 0);
  });
});

void describe('createClimbFilters: MoonBoard hold search', () => {
  const moonBoardParams: BoardRouteParams = {
    board_name: 'moonboard',
    layout_id: 2,
    size_id: 1,
    set_ids: [],
    angle: 40,
  };

  void it('matches ANY hold filters against the MoonBoard frame cell id', () => {
    const filters = createClimbFilters(moonBoardParams, {
      holdsFilter: { hold_56: { ANY: 'include' } },
    });

    assert.equal(filters.holdConditions.length, 1);
    assert.match(sqlToString(filters.holdConditions[0]), /frames like %p56r%/i);
  });

  void it('matches role-specific filters against MoonBoard climb-hold cell ids', () => {
    const filters = createClimbFilters(moonBoardParams, {
      holdsFilter: { hold_56: { STARTING: 'include' } },
    });

    assert.equal(filters.holdStateConditions.length, 1);
    const rendered = sqlToString(filters.holdStateConditions[0]);
    assert.match(rendered, /ch\.board_type = moonboard/);
    assert.match(rendered, /ch\.hold_id = 56/);
    assert.match(rendered, /ch\.hold_state IN \(STARTING\)/);
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

  void it('excludes climbs compatible with any shorter Homewall size via compatible_size_ids', () => {
    const filters = createClimbFilters(homewallTallParams, { onlyTallClimbs: true });

    assert.equal(filters.tallClimbsConditions.length, 1);
    const rendered = sqlToString(filters.tallClimbsConditions[0]);
    // NOT (compatible_size_ids && ARRAY[<shorter size ids>]::int[])
    assert.match(rendered, /NOT/);
    assert.match(rendered, /compatible_size_ids/);
    assert.match(rendered, /&&/);
    assert.match(rendered, /ARRAY\[/);
    assert.match(rendered, /::int\[\]/);
    // The shorter (10-high) Homewall sizes: 7x10 (17,18,19) + 10x10 (21,22,29).
    for (const shorterSizeId of [17, 18, 19, 21, 22, 29]) {
      assert.match(rendered, new RegExp(`(^|\\D)${shorterSizeId}(\\D|$)`));
    }
    // No longer the old climb-bottom-edge subquery.
    assert.doesNotMatch(rendered, /edge_bottom/);
  });

  void it('supports tall climbs on 8x12 Kilter Homewall sizes', () => {
    for (const sizeId of [23, 24]) {
      const filters = createClimbFilters({ ...homewallTallParams, size_id: sizeId }, { onlyTallClimbs: true });
      assert.equal(filters.tallClimbsConditions.length, 1);
      assert.notEqual(sqlToString(filters.tallClimbsConditions[0]), 'false');
      assert.match(sqlToString(filters.tallClimbsConditions[0]), /compatible_size_ids/);
    }
  });

  void it('generalizes tall climbs to other boards with a size grid (Tension Board 2)', () => {
    // Tension Board 2 layout 11 -> product 5; size 6 = "12 high x 12 wide".
    const filters = createClimbFilters(
      { board_name: 'tension', layout_id: 11, size_id: 6, set_ids: [], angle: 40 },
      { onlyTallClimbs: true },
    );
    assert.equal(filters.tallClimbsConditions.length, 1);
    const rendered = sqlToString(filters.tallClimbsConditions[0]);
    assert.notEqual(rendered, 'false');
    assert.match(rendered, /compatible_size_ids/);
    // The shorter (10-high) product-5 sizes are 7 and 9.
    for (const shorterSizeId of [7, 9]) {
      assert.match(rendered, new RegExp(`(^|\\D)${shorterSizeId}(\\D|$)`));
    }
  });

  void it('returns no results for tall climbs on the shortest size, mismatched, or unknown boards', () => {
    const unsupportedCases = [
      { ...homewallTallParams, size_id: 21 }, // 10x10 is the shortest — no shorter size exists
      { ...homewallTallParams, layout_id: 1 }, // size 25 (product 7) doesn't belong to layout 1 (product 1)
      { ...homewallTallParams, board_name: 'tension' as const }, // size 25 isn't a Tension size
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

  void it('excludes climbs compatible with any narrower Homewall size via compatible_size_ids', () => {
    const filters = createClimbFilters(homewallWideParams, { onlyWideClimbs: true });

    assert.equal(filters.wideClimbsConditions.length, 1);
    const rendered = sqlToString(filters.wideClimbsConditions[0]);
    assert.match(rendered, /NOT/);
    assert.match(rendered, /compatible_size_ids/);
    assert.match(rendered, /&&/);
    assert.match(rendered, /ARRAY\[/);
    // The narrower (8-wide) Homewall sizes: 7x10 (17,18,19) + 8x12 (23,24).
    for (const narrowerSizeId of [17, 18, 19, 23, 24]) {
      assert.match(rendered, new RegExp(`(^|\\D)${narrowerSizeId}(\\D|$)`));
    }
    // No longer the old hold-membership machinery.
    assert.doesNotMatch(rendered, /wide_ch/);
    assert.doesNotMatch(rendered, /hold_id/);
  });

  void it('is independent of selected route sets (compatible_size_ids is precomputed)', () => {
    // The old hold-based path narrowed by set_ids; the size-grid path does not.
    const withSets = sqlToString(
      createClimbFilters({ ...homewallWideParams, set_ids: [26] }, { onlyWideClimbs: true }).wideClimbsConditions[0],
    );
    const withoutSets = sqlToString(
      createClimbFilters({ ...homewallWideParams, set_ids: [] }, { onlyWideClimbs: true }).wideClimbsConditions[0],
    );
    assert.equal(withSets, withoutSets);
    assert.notEqual(withSets, 'false');
  });

  void it('generalizes wide climbs to other boards with a size grid (Tension Board 2)', () => {
    // Tension Board 2 layout 11 -> product 5; size 6 = "12 high x 12 wide".
    const filters = createClimbFilters(
      { board_name: 'tension', layout_id: 11, size_id: 6, set_ids: [], angle: 40 },
      { onlyWideClimbs: true },
    );
    assert.equal(filters.wideClimbsConditions.length, 1);
    const rendered = sqlToString(filters.wideClimbsConditions[0]);
    assert.notEqual(rendered, 'false');
    assert.match(rendered, /compatible_size_ids/);
    // The narrower (8-wide) product-5 sizes are 8 and 9.
    for (const narrowerSizeId of [8, 9]) {
      assert.match(rendered, new RegExp(`(^|\\D)${narrowerSizeId}(\\D|$)`));
    }
  });

  void it('returns no results for wide climbs on the narrowest size, mismatched, or unknown boards', () => {
    const unsupportedCases = [
      { ...homewallWideParams, size_id: 17 }, // 7x10 is the narrowest — no narrower size exists
      { ...homewallWideParams, layout_id: 1 }, // size 25 (product 7) doesn't belong to layout 1 (product 1)
      { ...homewallWideParams, board_name: 'tension' as const }, // size 25 isn't a Tension size
    ];

    for (const unsupportedParams of unsupportedCases) {
      const filters = createClimbFilters(unsupportedParams, { onlyWideClimbs: true });
      assert.equal(filters.wideClimbsConditions.length, 1);
      assert.equal(sqlToString(filters.wideClimbsConditions[0]), 'false');
    }
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

  void it('emits a positive benchmark_difficulty stats condition when onlyBenchmarks is on', () => {
    const f = createClimbFilters(params, { onlyBenchmarks: true });
    assert.equal(f.climbStatsConditions.length, 1);
    const rendered = sqlToString(f.climbStatsConditions[0]);
    assert.match(rendered, /benchmark_difficulty/);
    assert.match(rendered, /> 0/);
  });
});
