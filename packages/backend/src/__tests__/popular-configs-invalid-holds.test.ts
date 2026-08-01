import { describe, expect, it } from 'vite-plus/test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { POPULAR_CONFIGS_QUERY } from '../graphql/resolvers/social/boards';

describe('popular board configs invalid-hold safeguard', () => {
  it('renders all invalid-row guards inside the resolver query', () => {
    const query = new PgDialect().sqlToQuery(POPULAR_CONFIGS_QUERY);
    expect(query.sql.replace(/\s+/g, ' ')).toContain(
      "bch.hold_id > 0 AND bch.hold_state <> '' AND bch.hold_state NOT LIKE '%=%' AND NOT EXISTS",
    );
  });
});
