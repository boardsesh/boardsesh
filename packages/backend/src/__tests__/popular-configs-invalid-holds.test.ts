import { describe, expect, it } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { POPULAR_CONFIGS_QUERY } from '../graphql/resolvers/social/boards';

describe('popular board configs invalid-hold safeguard', () => {
  it('ignores corrupt hold rows but excludes real out-of-set holds, including Woods zero', async () => {
    // Execute the production query against statement-local catalog fixtures.
    // These CTEs shadow every source table without changing database contents.
    const rows = await db.execute(sql`
      WITH board_product_sizes_layouts_sets (board_type, layout_id, product_size_id, set_id, is_listed) AS (VALUES
        ('kilter', 1, 1, 1, true), ('woods', 1, 1, 1, true), ('woods', 1, 2, 2, true)
      ), board_sets (board_type, id, name) AS (VALUES
        ('kilter', 1, 'Kilter set'), ('woods', 1, 'Woods zero'), ('woods', 2, 'Woods one')
      ), board_layouts (board_type, id, name, is_listed) AS (VALUES
        ('kilter', 1, 'Kilter', true), ('woods', 1, 'Woods', true)
      ), board_product_sizes (board_type, id, name, description, is_listed, edge_left, edge_right, edge_bottom, edge_top) AS (
        SELECT board_type, product_size_id, 'Fixture', 'Fixture', true, 0, 100, 0, 100
        FROM board_product_sizes_layouts_sets
      ), user_boards (board_type, layout_id, size_id, deleted_at) AS (
        SELECT NULL::text, NULL::int, NULL::int, NULL::timestamp WHERE false
      ), board_climbs AS (
        SELECT uuid, board_type, 1 AS layout_id, true AS is_listed, false AS is_draft, false AS is_hidden,
          10 AS edge_left, 90 AS edge_right, 10 AS edge_bottom, 90 AS edge_top
        FROM (VALUES
          ('clean', 'kilter'), ('zero', 'kilter'), ('negative', 'kilter'), ('empty-state', 'kilter'),
          ('sentinel', 'kilter'), ('future-in-set', 'kilter'), ('out-of-set', 'kilter'),
          ('future-out-of-set', 'kilter'), ('woods-zero', 'woods')
        ) fixtures(uuid, board_type)
      ), board_climb_stats (board_type, climb_uuid, ascensionist_count) AS (
        SELECT board_type, uuid, 1 FROM board_climbs
      ), board_climb_holds (board_type, climb_uuid, hold_id, hold_state) AS (
        SELECT board_type, uuid, 100, 'STARTING' FROM board_climbs WHERE board_type = 'kilter'
        UNION ALL VALUES
          ('kilter', 'zero', 0, 'HAND'), ('kilter', 'negative', -1, 'HAND'),
          ('kilter', 'empty-state', 200, ''), ('kilter', 'sentinel', 200, '200=999'),
          ('kilter', 'future-in-set', 100, 'FUTURE_ROLE'), ('kilter', 'out-of-set', 200, 'HAND'),
          ('kilter', 'future-out-of-set', 200, 'FUTURE_ROLE'), ('woods', 'woods-zero', 0, 'STARTING')
      ), board_placements (board_type, layout_id, id, set_id) AS (VALUES
        ('kilter', 1, 100, 1), ('woods', 1, 0, 1), ('woods', 1, 1, 2)
      )
      ${POPULAR_CONFIGS_QUERY}
    `);
    expect(rows.map((row) => ({ board: row.board_type, size: row.size_id, climbs: row.climb_count }))).toEqual([
      { board: 'kilter', size: 1, climbs: 6 },
      { board: 'woods', size: 1, climbs: 1 },
      { board: 'woods', size: 2, climbs: 0 },
    ]);
  });
});
