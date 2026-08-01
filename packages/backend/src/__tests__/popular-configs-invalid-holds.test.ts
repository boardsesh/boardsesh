import { describe, expect, it } from 'vite-plus/test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { POPULAR_CONFIGS_QUERY } from '../graphql/resolvers/social/boards';

describe('popular board configs invalid-hold safeguard', () => {
  it('scopes structural guards and placement exclusion to the climb-count hold subquery', () => {
    const query = new PgDialect().sqlToQuery(POPULAR_CONFIGS_QUERY);
    expect(query.sql.replace(/\s+/g, ' ')).toContain(
      "AND NOT EXISTS ( SELECT 1 FROM board_climb_holds bch WHERE bch.climb_uuid = bc.uuid AND bch.board_type = bc.board_type AND bch.hold_id > 0 AND bch.hold_state <> '' AND bch.hold_state NOT LIKE '%=%' AND NOT EXISTS ( SELECT 1 FROM board_placements bp WHERE bp.board_type = bch.board_type AND bp.layout_id = bc.layout_id AND bp.id = bch.hold_id AND bp.set_id = ANY(configs.set_ids) ) )",
    );
  });
});
