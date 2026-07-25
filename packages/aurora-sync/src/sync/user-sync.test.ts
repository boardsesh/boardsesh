import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';

/** Driverless drizzle handle — `.toSQL()` renders without a connection. */
const renderOnlyDb = drizzle({} as never);
import { playlists, playlistClimbs, playlistOwnership } from '@boardsesh/db/schema/app';
import { foreignPlaylistOwnerGuard, upstreamPlaylistOwnersQuery } from '@boardsesh/db/queries';
import { upsertTableData, hasForeignOwnedCircuitPlaylists, DUPLICATE_CIRCUIT_OWNER_SKIP_REASON } from './user-sync';

/**
 * Hand-rolled Drizzle shim, not a real DB — same philosophy as kilter-sync's
 * `createRichTx`. It records every statement the circuits branch issues so a
 * test can assert that a refused circuit produces NO writes of any kind, and
 * hands back canned rows for the owner lookup.
 */
type DbCall = { kind: 'select' | 'insert' | 'delete' | 'conflict'; table?: unknown; args: unknown[] };
type SelectRows = Array<Record<string, unknown>>;

function createDbShim(
  opts: { selectResults?: SelectRows[]; returningRows?: Array<Array<Record<string, unknown>>> } = {},
) {
  const calls: DbCall[] = [];
  const selectResults = opts.selectResults ?? [];
  const returningQueue = opts.returningRows ?? [];
  let selectIdx = 0;
  let returningIdx = 0;

  const db = {
    select(cols: unknown) {
      calls.push({ kind: 'select', args: [cols] });
      const rows = selectResults[selectIdx++] ?? [];
      const source = {
        where: (_cond: unknown) => Promise.resolve(rows),
        leftJoin: (_table: unknown, _on: unknown) => source,
        innerJoin: (_table: unknown, _on: unknown) => source,
      };
      return { from: (_table: unknown) => source };
    },
    delete(table: unknown) {
      return {
        where: (cond: unknown) => {
          calls.push({ kind: 'delete', table, args: [cond] });
          return Promise.resolve();
        },
      };
    },
    insert(table: unknown) {
      return {
        values: (rows: unknown) => {
          calls.push({ kind: 'insert', table, args: [rows] });
          const chain = {
            onConflictDoUpdate: (conflictArgs: unknown) => {
              calls.push({ kind: 'conflict', table, args: [conflictArgs] });
              const returning = (_cols?: unknown) =>
                Promise.resolve(returningQueue[returningIdx++] ?? [{ id: BigInt(1) }]);
              return Object.assign(Promise.resolve(), { returning });
            },
            onConflictDoNothing: () => Promise.resolve(),
          };
          // playlist_climbs inserts are awaited straight off .values(), with no
          // conflict clause — so the chain object has to be thenable too.
          return Object.assign(Promise.resolve(), chain);
        },
      };
    },
  };

  const insertsInto = (table: unknown) => calls.filter((c) => c.kind === 'insert' && c.table === table);
  return { db, calls, insertsInto };
}

/** The real `PostgresJsDatabase` parameter type the shim is cast to. */
type ShimDb = Parameters<typeof upsertTableData>[0];

/**
 * `upsertTableData` takes `Record<string, string>` rows but the circuits branch
 * also reads a nested `climbs` array off them, so the fixture widens the value
 * type rather than casting each call site.
 */
type CircuitFixture = Parameters<typeof upsertTableData>[5][number];

const circuit = (uuid: string, name: string, climbs?: Array<{ climb_uuid: string }>): CircuitFixture =>
  ({
    uuid,
    name,
    description: '',
    color: '',
    is_public: '',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...(climbs ? { climbs } : {}),
  }) as unknown as CircuitFixture;

/**
 * #3526 / #3541: `playlists.aurora_id` is a GLOBAL unique index, so when one
 * Aurora account is linked to two Boardsesh users the second user's
 * `ON CONFLICT (aurora_id) DO UPDATE` lands on the first user's playlist and
 * the ownership insert grants them an `owner` edge. This is the path that
 * actually produced 8 cross-linked tension playlists in prod.
 */
describe('upsertTableData circuits — foreign-owner guard (#3526)', () => {
  it('a circuit owned by ANOTHER Boardsesh user produces no insert, no update and no delete', async () => {
    const logged: string[] = [];
    const { db, calls, insertsInto } = createDbShim({
      // Owner lookup: circuit-1's playlist belongs to user-2.
      selectResults: [[{ upstreamId: 'circuit-1', ownerUserId: 'user-2' }]],
    });

    const result = await upsertTableData(
      db as unknown as ShimDb,
      'tension',
      'circuits',
      144574,
      'user-1',
      [circuit('circuit-1', 'Renamed by user 1', [{ climb_uuid: 'climb-A' }])],
      (msg) => logged.push(msg),
    );

    // Each of the three write kinds asserted separately: the upsert is only
    // one of the ways this corrupted the other user's playlist. The ownership
    // INSERT granted the second owner; the playlist_climbs DELETE wiped their
    // climb list.
    expect(insertsInto(playlists)).toHaveLength(0);
    expect(insertsInto(playlistOwnership)).toHaveLength(0);
    expect(insertsInto(playlistClimbs)).toHaveLength(0);
    expect(calls.filter((c) => c.kind === 'delete')).toHaveLength(0);
    expect(calls.filter((c) => c.kind === 'conflict' && c.table === playlists)).toHaveLength(0);

    expect(result.skipped).toBe(1);
    // The board_circuits upsert ran for every row and is user-scoped by
    // aurora_user_id — those DID sync. Only the playlists mirror was refused.
    expect(result.synced).toBe(1);
    expect(result.skippedReason).toBe(DUPLICATE_CIRCUIT_OWNER_SKIP_REASON);
    expect(logged.some((line) => line.includes('already owned by a different Boardsesh user'))).toBe(true);
  });

  it('an already cross-linked playlist is refused in either direction', async () => {
    const logged: string[] = [];
    const { db, insertsInto } = createDbShim({
      selectResults: [
        [
          { upstreamId: 'circuit-1', ownerUserId: 'user-1' },
          { upstreamId: 'circuit-1', ownerUserId: 'user-2' },
        ],
      ],
    });

    const result = await upsertTableData(
      db as unknown as ShimDb,
      'tension',
      'circuits',
      144574,
      'user-1',
      [circuit('circuit-1', 'Shared')],
      (msg) => logged.push(msg),
    );

    expect(insertsInto(playlists)).toHaveLength(0);
    expect(insertsInto(playlistOwnership)).toHaveLength(0);
    expect(result.skipped).toBe(1);
    expect(logged.some((line) => line.includes('two owners'))).toBe(true);
  });

  it('writes normally when this user is the sole owner', async () => {
    const { db, insertsInto } = createDbShim({
      selectResults: [[{ upstreamId: 'circuit-1', ownerUserId: 'user-1' }]],
      returningRows: [[{ id: BigInt(7) }]],
    });

    const result = await upsertTableData(
      db as unknown as ShimDb,
      'tension',
      'circuits',
      144574,
      'user-1',
      [circuit('circuit-1', 'Mine')],
      () => {},
    );

    expect(insertsInto(playlists)).toHaveLength(1);
    expect(insertsInto(playlistOwnership)).toHaveLength(1);
    expect(result.skipped).toBe(0);
    expect(result.skippedReason).toBeUndefined();
  });

  it('claims a brand-new circuit and an orphaned playlist with no owner edge', async () => {
    const { db, insertsInto } = createDbShim({
      // circuit-new has no playlist at all; circuit-orphan has one whose
      // ownership rows are gone (LEFT join → null owner). Both are claimable.
      selectResults: [[{ upstreamId: 'circuit-orphan', ownerUserId: null }]],
      returningRows: [[{ id: BigInt(7) }], [{ id: BigInt(8) }]],
    });

    const result = await upsertTableData(
      db as unknown as ShimDb,
      'tension',
      'circuits',
      144574,
      'user-1',
      [circuit('circuit-new', 'New'), circuit('circuit-orphan', 'Orphan')],
      () => {},
    );

    expect(insertsInto(playlists)).toHaveLength(2);
    expect(insertsInto(playlistOwnership)).toHaveLength(2);
    expect(result.skipped).toBe(0);
  });

  it('counts every refused circuit in a mixed batch and writes only the owned ones', async () => {
    const logged: string[] = [];
    const { db, insertsInto } = createDbShim({
      selectResults: [
        [
          { upstreamId: 'mine', ownerUserId: 'user-1' },
          { upstreamId: 'theirs', ownerUserId: 'user-2' },
          { upstreamId: 'shared', ownerUserId: 'user-1' },
          { upstreamId: 'shared', ownerUserId: 'user-2' },
        ],
      ],
      returningRows: [[{ id: BigInt(7) }]],
    });

    const result = await upsertTableData(
      db as unknown as ShimDb,
      'tension',
      'circuits',
      144574,
      'user-1',
      [circuit('mine', 'Mine'), circuit('theirs', 'Theirs'), circuit('shared', 'Shared')],
      (msg) => logged.push(msg),
    );

    expect(insertsInto(playlists)).toHaveLength(1);
    expect(result.synced).toBe(3);
    expect(result.skipped).toBe(2);
    expect(logged.filter((line) => line.includes('duplicate board account link'))).toHaveLength(2);
  });

  it('attaches the NOT EXISTS ownership guard to the playlist upsert', async () => {
    const { db, calls } = createDbShim({
      selectResults: [[]],
      returningRows: [[{ id: BigInt(7) }]],
    });

    await upsertTableData(
      db as unknown as ShimDb,
      'tension',
      'circuits',
      144574,
      'user-1',
      [circuit('circuit-1', 'Mine')],
      () => {},
    );

    const conflictClause = calls.find((c) => c.kind === 'conflict' && c.table === playlists)?.args[0] as
      | { setWhere?: unknown }
      | undefined;
    expect(conflictClause?.setWhere).toBeDefined();
  });

  it('renders a correlated NOT EXISTS guard for the ON CONFLICT clause', () => {
    // Two daemons syncing two Boardsesh users on the SAME Aurora account can
    // both read "no playlist yet" and both INSERT; the loser's ON CONFLICT
    // would adopt the winner's row. #3539 widens that window, so the SQL-level
    // guard is load-bearing. Render the production fragment.
    const rendered = new PgDialect().sqlToQuery(foreignPlaylistOwnerGuard('user-b'));
    expect(rendered.sql).toContain('not exists');
    expect(rendered.sql).toContain('from "playlist_ownership"');
    expect(rendered.sql).toContain('"playlist_ownership"."playlist_id" = "playlists"."id"');
    expect(rendered.sql).toContain('"playlist_ownership"."user_id" <>');
    expect(rendered.params).toContain('owner');
    expect(rendered.params).toContain('user-b');
  });
});

describe('upsertTableData circuits — race-guard suppression + owner lookup SQL', () => {
  it('does not touch ownership or climbs when the SQL race guard suppresses the upsert', async () => {
    // setWhere matched nothing → DO UPDATE was a no-op → .returning() is empty.
    // The rest of the item must be abandoned, not run against an undefined id.
    const { db, calls, insertsInto } = createDbShim({
      selectResults: [[]],
      returningRows: [[]],
    });

    await upsertTableData(
      db as unknown as ShimDb,
      'tension',
      'circuits',
      144574,
      'user-1',
      [circuit('circuit-1', 'Lost the race', [{ climb_uuid: 'climb-A' }])],
      () => {},
    );

    expect(insertsInto(playlistOwnership)).toHaveLength(0);
    expect(insertsInto(playlistClimbs)).toHaveLength(0);
    expect(calls.filter((c) => c.kind === 'delete')).toHaveLength(0);
  });

  it('renders the owner lookup with the role filter, LEFT JOIN and aurora_id column', () => {
    // The shim ignores SQL entirely, so without this the owner lookup — which
    // decides every case above — has no coverage: dropping `role = 'owner'` or
    // swapping the join keeps every other test green.
    // Renders the query selectUpstreamPlaylistOwners actually awaits — a
    // driverless drizzle handle is enough, .toSQL() never touches a connection.
    const rendered = upstreamPlaylistOwnersQuery(renderOnlyDb, playlists.auroraId, ['circuit-1']).toSQL();
    expect(rendered.sql).toContain('from "playlists"');
    expect(rendered.sql).toContain('left join "playlist_ownership"');
    expect(rendered.sql).toContain('"playlist_ownership"."role" =');
    expect(rendered.sql).toContain('"playlists"."aurora_id" in');
    expect(rendered.params).toContain('owner');
    expect(rendered.params).toContain('circuit-1');
  });
});

/**
 * The state query behind the user-facing sync_error. Validated against prod
 * too: it flags both halves of the known duplicate Tension pair and none of the
 * other 110 Tension users.
 */
describe('hasForeignOwnedCircuitPlaylists (#3526)', () => {
  /**
   * Stub for `.select().from().innerJoin().innerJoin().where().limit()`.
   *
   * `captured.where` holds the REAL predicate the production code passed.
   * Always render that — never rebuild the condition in the test. A rebuilt
   * copy only proves drizzle renders `eq` as `=`, and drifts silently the
   * moment production changes (see upstreamPlaylistOwnersQuery for the same
   * lesson learned the hard way).
   */
  function stubDb(rows: Array<Record<string, unknown>>) {
    const captured: { where?: unknown } = {};
    const source = {
      innerJoin: (_table: unknown, _on: unknown) => source,
      where: (condition: unknown) => {
        captured.where = condition;
        return { limit: (_n: number) => Promise.resolve(rows) };
      },
    };
    return { db: { select: () => ({ from: () => source }) }, captured };
  }

  it("reports a duplicate when a foreign owner holds one of the account's circuits", async () => {
    const { db } = stubDb([{ playlistId: BigInt(1) }]);
    await expect(hasForeignOwnedCircuitPlaylists(db as never, 'tension', 144574, 'user-1')).resolves.toBe(true);
  });

  it('reports no duplicate when nothing conflicts', async () => {
    const { db } = stubDb([]);
    await expect(hasForeignOwnedCircuitPlaylists(db as never, 'tension', 49399, 'user-1')).resolves.toBe(false);
  });

  it('scopes to this board, this Aurora account, and OTHER owners only', async () => {
    // Renders the predicate PRODUCTION passed, pulled out of the stub. Flipping
    // `ne(playlistOwnership.userId, ...)` to `eq` in user-sync.ts is the
    // loudest failure mode in this change — every healthy Aurora user would get
    // a permanent, false "circuits aren't syncing" banner — and a predicate
    // rebuilt here would not notice.
    const { db, captured } = stubDb([]);

    await hasForeignOwnedCircuitPlaylists(db as never, 'tension', 144574, 'user-1');

    expect(captured.where).toBeDefined();
    const rendered = new PgDialect().sqlToQuery(captured.where as never);
    expect(rendered.sql).toContain('"board_circuits"."board_type" =');
    expect(rendered.sql).toContain('"board_circuits"."user_id" =');
    // The load-bearing character in the whole predicate.
    expect(rendered.sql).toContain('"playlist_ownership"."user_id" <>');
    expect(rendered.sql).not.toContain('"playlist_ownership"."user_id" =');
    expect(rendered.params).toEqual(['tension', 144574, 'user-1']);
  });
});
