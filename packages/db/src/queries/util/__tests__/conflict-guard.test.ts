import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { boardBetaLinks } from '../../../schema/boards/unified';
import { conflictSetChangesRowSql, conflictSetEntries } from '../conflict-guard';

const dialect = new PgDialect();

describe('conflict guard', () => {
  it('compares the stored tuple with the SET values, in SET order', () => {
    const entries = conflictSetEntries(boardBetaLinks, {
      thumbnail: sql`excluded.thumbnail`,
      isListed: sql`COALESCE(excluded.is_listed, ${boardBetaLinks.isListed})`,
    });
    assert.equal(
      dialect.sqlToQuery(conflictSetChangesRowSql(entries)).sql,
      '("board_beta_links"."thumbnail", "board_beta_links"."is_listed") IS DISTINCT FROM (excluded.thumbnail, COALESCE(excluded.is_listed, "board_beta_links"."is_listed"))',
    );
  });

  it('throws on a SET key the table does not have, so the guard cannot drop it silently', () => {
    assert.throws(
      () => conflictSetEntries(boardBetaLinks, { notAColumn: sql`excluded.x` }),
      /no column "notAColumn" on board_beta_links/,
    );
  });
});
