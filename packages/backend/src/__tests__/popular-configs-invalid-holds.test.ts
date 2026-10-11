import { describe, expect, it } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { popularBoardConfigsQuery } from '../services/popular-board-configs';

describe('popular board configs denormalized set filter', () => {
  it('uses derived set requirements and keeps Woods and MoonBoard catalog semantics', async () => {
    // Execute the production query against statement-local catalog fixtures.
    // These CTEs shadow every source table without changing database contents.
    const rows = await db.execute(sql`
      WITH board_product_sizes_layouts_sets (board_type, layout_id, product_size_id, set_id, is_listed) AS (VALUES
        ('kilter', 1, 1, 1, true), ('moonboard', 1, 1, 1, true),
        ('woods', 1, 1, 1, true), ('woods', 1, 2, 2, true)
      ), board_sets (board_type, id, name) AS (VALUES
        ('kilter', 1, 'Kilter set'), ('kilter', 2, 'Kilter set 2'),
        ('moonboard', 1, 'MoonBoard set'), ('woods', 1, 'Woods zero'), ('woods', 2, 'Woods one')
      ), board_layouts (board_type, id, name, is_listed) AS (VALUES
        ('kilter', 1, 'Kilter', true), ('moonboard', 1, 'MoonBoard', true), ('woods', 1, 'Woods', true)
      ), board_product_sizes (board_type, id, name, description, is_listed, edge_left, edge_right, edge_bottom, edge_top) AS (
        SELECT board_type, product_size_id, 'Fixture', 'Fixture', true, 0, 100, 0, 100
        FROM board_product_sizes_layouts_sets
      ), user_boards (board_type, layout_id, size_id, deleted_at) AS (
        SELECT NULL::text, NULL::int, NULL::int, NULL::timestamp WHERE false
      ), board_placements (board_type, layout_id, id, set_id) AS (VALUES
        ('kilter', 1, 100, 1), ('kilter', 1, 200, 2),
        ('woods', 1, 0, 1), ('woods', 1, 1, 2)
      ), board_climb_inputs (uuid, board_type, frames) AS (VALUES
        ('clean', 'kilter', 'p100r12'), ('zero', 'kilter', 'p0r13p100r12'),
        ('negative', 'kilter', 'p-1r13p100r12'), ('empty-state', 'kilter', 'p100r12'),
        ('sentinel', 'kilter', 'p100r12'), ('future-in-set', 'kilter', 'p100r999'),
        ('out-of-set', 'kilter', 'p100r12p200r12'),
        ('future-out-of-set', 'kilter', 'p100r999p200r999'),
        ('woods-zero', 'woods', 'p0r4'), ('moonboard-null', 'moonboard', 'p1r12')
      ), board_climbs AS (
        SELECT fixture.uuid, fixture.board_type, 1 AS layout_id,
          true AS is_listed, false AS is_draft, false AS is_hidden,
          CASE
            WHEN fixture.board_type = 'woods' THEN ARRAY[]::integer[]
            WHEN fixture.board_type = 'moonboard' THEN NULL::integer[]
            ELSE derived.required_set_ids
          END AS required_set_ids,
          10 AS edge_left, 90 AS edge_right, 10 AS edge_bottom, 90 AS edge_top
        FROM board_climb_inputs fixture
        LEFT JOIN LATERAL (
          SELECT ARRAY_AGG(DISTINCT placement.set_id ORDER BY placement.set_id) AS required_set_ids
          FROM regexp_matches(fixture.frames, 'p(\\d+)r', 'g') AS matched(hold_id)
          JOIN board_placements placement
            ON placement.id = (matched.hold_id[1])::integer
            AND placement.board_type = fixture.board_type
            AND placement.layout_id = 1
        ) derived ON true
      ), board_climb_stats (board_type, climb_uuid, ascensionist_count) AS (
        SELECT board_type, uuid, 1 FROM board_climbs
      )
      ${popularBoardConfigsQuery()}
    `);
    const counts = rows
      .map((row) => ({
        board: String(row.board_type),
        size: Number(row.size_id),
        climbs: Number(row.climb_count),
      }))
      .sort((left, right) => left.board.localeCompare(right.board) || left.size - right.size);
    expect(counts).toEqual([
      { board: 'kilter', size: 1, climbs: 6 },
      { board: 'moonboard', size: 1, climbs: 1 },
      { board: 'woods', size: 1, climbs: 1 },
      { board: 'woods', size: 2, climbs: 1 },
    ]);
  });
});
