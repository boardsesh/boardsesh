/**
 * The two correlated subqueries behind UserProfile.hasPassword and
 * UserProfile.linkedProviders (issue #1884).
 *
 * Every other test in the profile domain mocks the db client, so nothing there
 * looks at the SQL these hand-written `sql` fragments actually render. The
 * backend's test database doesn't carry `accounts` or `user_credentials`
 * either, so a real-DB test isn't available to catch it. That leaves the
 * riskiest code in the slice uncovered, and the failure mode is not a blank
 * field: `Query.profile` is what the shipped iOS/Android binaries call for the
 * Profile tab, so a fragment that doesn't parse or doesn't correlate is a hard
 * error on a screen every user reaches.
 *
 * `accounts` is the easy one to get wrong: its FK column is the quoted
 * camelCase `"userId"` that NextAuth's adapter requires, not `user_id` like
 * every other table here. Rendering the fragments and reading the SQL back is
 * enough to pin that.
 */

import { describe, it, expect } from 'vite-plus/test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { HAS_PASSWORD_SUBQUERY, LINKED_PROVIDERS_SUBQUERY } from '../profile-row';

const dialect = new PgDialect();

function render(fragment: Parameters<PgDialect['sqlToQuery']>[0]): string {
  return dialect.sqlToQuery(fragment).sql;
}

describe('PROFILE_SELECT subqueries', () => {
  it('scopes hasPassword to the outer users row', () => {
    const rendered = render(HAS_PASSWORD_SUBQUERY);

    expect(rendered).toContain('"user_credentials"');
    // Correlated, not a table-wide exists(): without the outer reference every
    // account with a password would make every profile report hasPassword.
    expect(rendered).toContain('"user_credentials"."user_id" = "users"."id"');
    expect(rendered).toMatch(/^\(select exists/);
  });

  it("aggregates linkedProviders off accounts' camelCase FK column", () => {
    const rendered = render(LINKED_PROVIDERS_SUBQUERY);

    expect(rendered).toContain('array_agg("accounts"."provider")');
    // NextAuth's adapter names this column "userId", not user_id. Rendering it
    // unquoted or snake_cased makes the whole profile query throw at runtime.
    expect(rendered).toContain('"accounts"."userId" = "users"."id"');
    // array_agg over zero rows is NULL; the coalesce is what keeps the
    // non-null [String!]! contract from blowing up for a password-only account.
    expect(rendered).toContain('coalesce(');
    expect(rendered).toContain("'{}'");
  });
});
