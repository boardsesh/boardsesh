import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { drizzle } from 'drizzle-orm/pg-proxy';
import { aliveHolds } from '../holds';

type CapturedQuery = { sql: string; params: unknown[] };

/**
 * A real drizzle PgDatabase over the pg-proxy driver, so the query BUILDER runs
 * and we assert the SQL it renders — a hand-rolled fake of `.select().from()…`
 * would only assert the fake. `publishedVersion` is what the
 * `spray_walls`-resolving query answers; undefined means the wall has never
 * published a version.
 */
function makeProxyDb(publishedVersion?: number) {
  const queries: CapturedQuery[] = [];
  const db = drizzle(async (sql: string, params: unknown[]) => {
    queries.push({ sql, params });
    const resolvesCurrentVersion = sql.includes('from "spray_walls"');
    if (resolvesCurrentVersion) {
      return { rows: publishedVersion === undefined ? [] : [[publishedVersion]] };
    }
    return { rows: [] };
  });
  return { queries, db: db as never };
}

void describe('aliveHolds — the published-version path (no versionNumber)', () => {
  void it('resolves the wall’s published version instead of trusting removed_version_id IS NULL', async () => {
    // The whole point: while a reset is a DRAFT, its added holds already have
    // rows and its removals are only removals AT the draft. Reading "alive" as
    // `removed_version_id IS NULL` would show climbers that unpublished layout.
    const proxy = makeProxyDb(4);
    await aliveHolds(proxy.db, 7);

    assert.equal(proxy.queries.length, 2, 'one query resolves the published version, one reads the holds');
    const [resolve, read] = proxy.queries;
    assert.match(resolve.sql, /from "spray_walls"/);
    assert.match(resolve.sql, /"current_version"\."version_number"/);
    assert.match(resolve.sql, /"spray_walls"\."current_version_id" is not null/);
    // The wall id, then drizzle's own `limit 1` parameter.
    assert.deepEqual(resolve.params, [7, 1]);

    // The holds read is the same bounded query the historical path uses, at the
    // published version number.
    assert.match(read.sql, /from "spray_wall_holds"/);
    assert.match(read.sql, /"installed_version"\."version_number" <= \$\d/);
    assert.match(read.sql, /"removed_version"\."version_number" > \$\d/);
    assert.deepEqual(read.params, [7, 4, 4]);
  });

  void it('returns nothing, and reads no holds, when the wall has never published', async () => {
    const proxy = makeProxyDb(undefined);
    assert.deepEqual(await aliveHolds(proxy.db, 7), []);
    assert.equal(proxy.queries.length, 1, 'an unpublished wall must not fall through to a hold read');
  });

  void it('never treats a NULL removed_version_id as the only aliveness test', async () => {
    const proxy = makeProxyDb(4);
    await aliveHolds(proxy.db, 7);
    const read = proxy.queries[1].sql;
    // NULL is one arm of an OR with the version bound, not the whole predicate.
    assert.match(read, /"removed_version_id" is null or "removed_version"\."version_number" > \$\d/);
  });
});

void describe('aliveHolds — the historical path (explicit versionNumber)', () => {
  void it('skips the resolve and bounds both ends on the version asked for', async () => {
    const proxy = makeProxyDb(4);
    await aliveHolds(proxy.db, 7, 2);

    assert.equal(proxy.queries.length, 1, 'an explicit version needs no lookup');
    const [read] = proxy.queries;
    assert.match(read.sql, /from "spray_wall_holds"/);
    assert.match(read.sql, /inner join "spray_wall_versions" "installed_version"/);
    assert.match(read.sql, /left join "spray_wall_versions" "removed_version"/);
    assert.deepEqual(read.params, [7, 2, 2], 'the wall id, then the version on both bounds');
  });

  void it('scopes to the wall and orders by hold id', async () => {
    const proxy = makeProxyDb(4);
    await aliveHolds(proxy.db, 7, 2);
    const [read] = proxy.queries;
    assert.match(read.sql, /"spray_wall_holds"\."wall_id" = \$\d/);
    assert.match(read.sql, /order by "spray_wall_holds"\."hold_id" asc/);
  });

  void it('reads version 1 of a wall that has published nothing yet', async () => {
    // A draft wall's owner still has to see the draft — by naming its number.
    const proxy = makeProxyDb(undefined);
    await aliveHolds(proxy.db, 7, 1);
    assert.equal(proxy.queries.length, 1);
    assert.deepEqual(proxy.queries[0].params, [7, 1, 1]);
  });
});
