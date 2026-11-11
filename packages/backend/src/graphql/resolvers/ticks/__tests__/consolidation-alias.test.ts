import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { acquireUserTickMutationLock } from '@boardsesh/db/queries';
import { boardseshTicks } from '@boardsesh/db/schema/app';
import { eq } from 'drizzle-orm';
import { getWorkerDatabaseName } from '../../../../__tests__/worker-db';
import { resolveConsolidatedTickAddress, tombstoneConsolidatedTicks } from '../consolidation-alias';

const adminUrl = (
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/boardsesh_backend_test'
).replace(/\/[^/]+$/, '/postgres');
const databaseName = getWorkerDatabaseName('bs_consolidation_alias');
let admin: postgres.Sql;
let client: postgres.Sql;
let created = false;
describe('owner-scoped consolidation tick aliases', () => {
  beforeAll(async () => {
    admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    created = true;
    client = postgres(adminUrl.replace(/\/[^/]+$/, `/${databaseName}`), { max: 2, onnotice: () => {} });
    await client.unsafe(`CREATE TABLE boardsesh_ticks(uuid text PRIMARY KEY,user_id text NOT NULL,updated_at timestamp NOT NULL DEFAULT now());
      CREATE TABLE account_consolidation_tick_aliases(retired_uuid text PRIMARY KEY,canonical_uuid text,target_user_id text NOT NULL,merge_id text NOT NULL,tombstoned boolean NOT NULL DEFAULT false);
      CREATE TABLE account_consolidation_import_aliases(former_user_id text,provider text,kind text,external_id text,canonical_resource_id text,target_user_id text,merge_id text,tombstoned boolean NOT NULL DEFAULT false);
      CREATE TABLE account_consolidation_members(source_user_id text PRIMARY KEY,canonical_user_id text,merge_id text,status text,applied_at timestamptz NOT NULL DEFAULT '2026-02-01T00:00:00Z');
      INSERT INTO account_consolidation_members VALUES ('source','owner','merge','applied');
      INSERT INTO boardsesh_ticks VALUES ('canonical','owner'),('mode-canonical','owner');
      INSERT INTO account_consolidation_tick_aliases VALUES ('retired','canonical','owner','merge',false),('dangling','missing','owner','merge',false),('mode-retired','mode-canonical','owner','merge',false);`);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await client?.end({ timeout: 1 });
    if (created) await admin.unsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    await admin?.end({ timeout: 1 });
  });
  it('keeps applied address mappings active with session exchange off', async () => {
    vi.stubEnv('ACCOUNT_CONSOLIDATION_BRIDGE_MODE', 'off');
    expect(await resolveConsolidatedTickAddress(drizzle(client), 'mode-retired', 'owner')).toBe('mode-canonical');
  });
  it('resolves the canonical tick only for its current owner', async () => {
    vi.stubEnv('ACCOUNT_CONSOLIDATION_BRIDGE_MODE', 'enabled');
    expect(await resolveConsolidatedTickAddress(drizzle(client), 'retired', 'owner')).toBe('canonical');
    await expect(resolveConsolidatedTickAddress(drizzle(client), 'retired', 'other')).rejects.toThrow('Tick not found');
  });
  it('rejects dangling aliases instead of allowing a stale save to recreate them', async () => {
    vi.stubEnv('ACCOUNT_CONSOLIDATION_BRIDGE_MODE', 'enabled');
    await expect(resolveConsolidatedTickAddress(drizzle(client), 'dangling', 'owner')).rejects.toThrow(
      'Tick not found',
    );
  });
  it('tombstones both UUIDs atomically and tolerates repeated cleanup', async () => {
    vi.stubEnv('ACCOUNT_CONSOLIDATION_BRIDGE_MODE', 'enabled');
    await drizzle(client).transaction(async (tx) => {
      await tombstoneConsolidatedTicks(tx, 'owner', ['canonical']);
      await tombstoneConsolidatedTicks(tx, 'owner', ['canonical']);
    });
    await expect(resolveConsolidatedTickAddress(drizzle(client), 'retired', 'owner')).rejects.toThrow('Tick not found');
    await expect(resolveConsolidatedTickAddress(drizzle(client), 'canonical', 'owner')).rejects.toThrow(
      'Tick not found',
    );
  });
  it('tombstones a moved native UUID even when no upstream or duplicate alias exists', async () => {
    vi.stubEnv('ACCOUNT_CONSOLIDATION_BRIDGE_MODE', 'enabled');
    await client`INSERT INTO boardsesh_ticks VALUES('moved-native','owner')`;
    await drizzle(client).transaction((tx) => tombstoneConsolidatedTicks(tx, 'owner', ['moved-native']));
    await expect(resolveConsolidatedTickAddress(drizzle(client), 'moved-native', 'owner')).rejects.toThrow(
      'Tick not found',
    );
  });
  it('tombstones the frozen import identity with its deleted canonical event', async () => {
    vi.stubEnv('ACCOUNT_CONSOLIDATION_BRIDGE_MODE', 'enabled');
    await client`INSERT INTO boardsesh_ticks VALUES('imported-event','owner')`;
    await client`INSERT INTO account_consolidation_import_aliases VALUES('source','aurora','tick','json-import-old','imported-event','owner','merge',false)`;
    await drizzle(client).transaction((tx) => tombstoneConsolidatedTicks(tx, 'owner', ['imported-event']));
    expect(
      await client`SELECT tombstoned FROM account_consolidation_import_aliases WHERE external_id='json-import-old'`,
    ).toEqual([{ tombstoned: true }]);
  });
  it('serializes a stale save address check behind a deleting user transaction', async () => {
    vi.stubEnv('ACCOUNT_CONSOLIDATION_BRIDGE_MODE', 'enabled');
    await client`INSERT INTO boardsesh_ticks VALUES('race-native','owner')`;
    let announceDelete: () => void = () => {};
    let releaseDelete: () => void = () => {};
    const deleteReady = new Promise<void>((resolve) => {
      announceDelete = resolve;
    });
    const mayDelete = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    const deletion = drizzle(client).transaction(async (tx) => {
      await acquireUserTickMutationLock(tx, 'owner');
      await tombstoneConsolidatedTicks(tx, 'owner', ['race-native']);
      announceDelete();
      await mayDelete;
      await tx.delete(boardseshTicks).where(eq(boardseshTicks.uuid, 'race-native'));
    });
    await deleteReady;
    const staleSave = drizzle(client).transaction(async (tx) => {
      await acquireUserTickMutationLock(tx, 'owner');
      return resolveConsolidatedTickAddress(tx, 'race-native', 'owner');
    });
    releaseDelete();
    await deletion;
    await expect(staleSave).rejects.toThrow('Tick not found');
    expect(await client`SELECT count(*)::integer AS total FROM boardsesh_ticks WHERE uuid='race-native'`).toEqual([
      { total: 0 },
    ]);
  });
  it('rejects stale alias edits/deletes after canonical edits while direct IDs remain usable', async () => {
    await client`INSERT INTO boardsesh_ticks(uuid,user_id,updated_at) VALUES('edited-canonical','owner','2026-01-01')`;
    await client`INSERT INTO account_consolidation_tick_aliases VALUES('edited-retired','edited-canonical','owner','merge',false)`;
    expect(
      await resolveConsolidatedTickAddress(drizzle(client), 'edited-retired', 'owner', { mutation: 'update' }),
    ).toBe('edited-canonical');
    await client`UPDATE boardsesh_ticks SET updated_at='2026-03-01' WHERE uuid='edited-canonical'`;
    for (const mutation of ['update', 'delete'] as const)
      await expect(
        resolveConsolidatedTickAddress(drizzle(client), 'edited-retired', 'owner', { mutation }),
      ).rejects.toMatchObject({ extensions: { code: 'CONFLICT' } });
    expect(await resolveConsolidatedTickAddress(drizzle(client), 'edited-retired', 'owner')).toBe('edited-canonical');
    expect(
      await resolveConsolidatedTickAddress(drizzle(client), 'edited-canonical', 'owner', { mutation: 'update' }),
    ).toBe('edited-canonical');
  });
  it('keeps applied data mappings independent of the session exchange setting', async () => {
    vi.stubEnv('ACCOUNT_CONSOLIDATION_BRIDGE_MODE', 'typo');
    expect(await resolveConsolidatedTickAddress(drizzle(client), 'mode-retired', 'owner')).toBe('mode-canonical');
  });
});
