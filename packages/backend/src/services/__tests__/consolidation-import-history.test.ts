import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { loadConsolidationImportHistory, refreshUserClimbPercentiles } from '@boardsesh/db/queries';
import { getWorkerDatabaseName } from '../../__tests__/worker-db';

const adminUrl = (
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/boardsesh_backend_test'
).replace(/\/[^/]+$/, '/postgres');
const databaseName = getWorkerDatabaseName('bs_consolidation_import_history');
let admin: postgres.Sql;
let client: postgres.Sql;
let created = false;
describe('consolidated frozen import identities', () => {
  beforeAll(async () => {
    admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    created = true;
    client = postgres(adminUrl.replace(/\/[^/]+$/, `/${databaseName}`), { max: 1, onnotice: () => {} });
    await client.unsafe(`CREATE TABLE account_consolidation_members(source_user_id text,canonical_user_id text,status text);
      CREATE TABLE account_consolidation_import_aliases(former_user_id text,provider text,kind text,external_id text,canonical_resource_id text,target_user_id text,merge_id text,tombstoned boolean);
      CREATE TABLE account_consolidation_tick_aliases(retired_uuid text,canonical_uuid text,target_user_id text,merge_id text,tombstoned boolean);
      CREATE TABLE users(id text PRIMARY KEY);
      CREATE TABLE boardsesh_ticks(user_id text,climb_uuid text,status text);
      CREATE TABLE user_climb_percentiles(user_id text PRIMARY KEY,total_distinct_climbs integer,percentile double precision,total_active_users integer,computed_at timestamp);
      INSERT INTO users VALUES ('survivor'),('source'),('other');
      INSERT INTO account_consolidation_members VALUES ('source','survivor','applied');
      INSERT INTO account_consolidation_import_aliases VALUES
      ('source','aurora','tick','old-hash','tick-1','survivor','merge',false),
      ('source','aurora','tick','deleted-hash',NULL,'survivor','merge',true),
      ('source','aurora','playlist','circuit-a','playlist-1','survivor','merge',false),
      ('survivor','aurora','playlist','circuit-b','playlist-2','survivor','merge',false),
      ('source','moonboard','tick','old-moon','tick-2','survivor','merge',false);
      INSERT INTO account_consolidation_tick_aliases VALUES ('retired','tick-1','survivor','merge',false);
      INSERT INTO boardsesh_ticks VALUES ('survivor','climb-a','send'),('survivor','climb-a','flash'),('survivor','climb-b','send'),('other','climb-c','send'),('source','retired-only','send');
      INSERT INTO user_climb_percentiles VALUES ('source',77,88,99,now());`);
  });
  afterAll(async () => {
    await client?.end({ timeout: 1 });
    if (created) await admin.unsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    await admin?.end({ timeout: 1 });
  });
  it('reuses former account IDs and deletion tombstones only for the approved survivor', async () => {
    const history = await loadConsolidationImportHistory(drizzle(client), 'survivor');
    expect(history.formerUserIds).toEqual(['source']);
    expect(history.resolve('aurora', 'tick', ['new-hash', 'old-hash'])).toBe('tick-1');
    expect(history.resolve('aurora', 'tick', ['deleted-hash'])).toBeNull();
    expect(history.resolve('moonboard', 'tick', ['old-moon'])).toBe('tick-2');
    expect(
      (await loadConsolidationImportHistory(drizzle(client), 'other')).resolve('aurora', 'tick', ['old-hash']),
    ).toBeUndefined();
  });
  it('refuses to merge distinct resources with the same export shape', async () => {
    const history = await loadConsolidationImportHistory(drizzle(client), 'survivor');
    expect(() => history.resolve('aurora', 'playlist', ['circuit-a', 'circuit-b'])).toThrow('Ambiguous');
  });
  it('refreshes the canonical rank while preserving retired historical snapshots', async () => {
    await refreshUserClimbPercentiles(drizzle(client));
    const rows = await client`SELECT * FROM user_climb_percentiles ORDER BY user_id`;
    expect(rows.find((row) => row.user_id === 'survivor')).toMatchObject({
      total_distinct_climbs: 2,
      percentile: 50,
      total_active_users: 2,
    });
    expect(rows.find((row) => row.user_id === 'source')).toMatchObject({
      total_distinct_climbs: 77,
      percentile: 88,
      total_active_users: 99,
    });
  });
});
