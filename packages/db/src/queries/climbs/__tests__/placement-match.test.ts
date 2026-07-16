import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { sqlText } from '../../../test-utils/sql-text';
import { climbHoldPlacementMatchSql, moonBoardPlacementCoverageSql } from '../placement-match';

void test('climbHoldPlacementMatchSql bridges MoonBoard cells and preserves placement IDs elsewhere', () => {
  const rendered = sqlText(
    climbHoldPlacementMatchSql({
      boardType: sql.raw('climb_holds.board_type'),
      climbHoldId: sql.raw('climb_holds.hold_id'),
      placementId: sql.raw('placements.id'),
      placementHoleId: sql.raw('placements.hole_id'),
    }),
  );

  assert.match(rendered, /board_type = 'moonboard'/);
  assert.match(rendered, /placements\.hole_id = climb_holds\.hold_id/);
  assert.match(rendered, /board_type <> 'moonboard'/);
  assert.match(rendered, /placements\.id = climb_holds\.hold_id/);
});

void test('moonBoardPlacementCoverageSql excludes an entire climb when a cell is unmapped', () => {
  const rendered = sqlText(
    moonBoardPlacementCoverageSql({
      boardType: sql.raw('climbs.board_type'),
      climbUuid: sql.raw('climbs.uuid'),
      layoutId: sql.raw('climbs.layout_id'),
    }),
  );

  assert.match(rendered, /climbs\.board_type <> 'moonboard'/);
  assert.match(rendered, /NOT EXISTS/);
  assert.match(rendered, /coverage_ch\.climb_uuid = climbs\.uuid/);
  assert.match(rendered, /coverage_bp\.layout_id = climbs\.layout_id/);
  assert.match(rendered, /coverage_bp\.hole_id = coverage_ch\.hold_id/);
});
