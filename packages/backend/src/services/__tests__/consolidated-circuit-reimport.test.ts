import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { generateJsonImportCircuitAuroraId, importJsonExportData } from '@boardsesh/aurora-sync/json-import';
import { schemaSQL } from '../../__tests__/schema-sql';
import { getWorkerDatabaseName } from '../../__tests__/worker-db';

const adminUrl = (process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/postgres').replace(
  /\/[^/]+$/,
  '/postgres',
);
const databaseName = getWorkerDatabaseName('bs_consolidated_circuits');
const createdAt = '2026-01-01T00:00:00.000Z';
const frozenId = generateJsonImportCircuitAuroraId('source', 'tension', 'Training', createdAt);
let admin: postgres.Sql;
let client: postgres.Sql;
let created = false;
function reimport(climbs = ['New climb', 'Old climb']) {
  return importJsonExportData(
    drizzle(client),
    'canonical',
    'tension',
    {
      user: { username: 'fixture' },
      ascents: [],
      attempts: [],
      likes: [],
      climbs: [],
      circuits: [
        { name: 'Training', created_at: createdAt, description: 'Updated description', color: '#00ff00', climbs },
      ],
    },
    undefined,
    { skipFinalization: true },
  );
}
describe('consolidated circuit reimports', () => {
  beforeAll(async () => {
    admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    created = true;
    client = postgres(adminUrl.replace(/\/[^/]+$/, `/${databaseName}`), { max: 1, onnotice: () => {} });
    await client.unsafe(schemaSQL);
  });
  afterAll(async () => {
    await client?.end({ timeout: 1 });
    if (created) await admin.unsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    await admin?.end({ timeout: 1 });
  });
  beforeEach(async () => {
    await client.unsafe(
      'TRUNCATE users,playlists,account_consolidation_members,account_consolidation_import_aliases,account_consolidation_tick_aliases CASCADE',
    );
    await client`INSERT INTO users(id,email) VALUES('canonical','canonical@fixture.test'),('source','source@fixture.test'),('foreign','foreign@fixture.test')`;
    await client`INSERT INTO board_climbs(uuid,board_type,layout_id,setter_username,name,frames,frames_count,is_draft,is_listed,edge_left,edge_right,edge_bottom,edge_top,created_at) VALUES('old-climb','tension',1,'fixture','Old climb','p1r1',1,false,true,0,100,0,150,'2024-01-01'),('new-climb','tension',1,'fixture','New climb','p1r1',1,false,true,0,100,0,150,'2024-01-01')`;
    await client`INSERT INTO account_consolidation_members(source_user_id,canonical_user_id,merge_id,status,applied_at) VALUES('source','canonical','fixture-merge','applied',now())`;
    await client`INSERT INTO playlists(uuid,board_type,name,description,color,aurora_id,aurora_type) VALUES('retained-playlist','tension','Original title','Original description','#000000',${frozenId},'circuits')`;
    await client`INSERT INTO playlist_ownership(playlist_id,user_id,role) SELECT id,'canonical','owner' FROM playlists`;
    await client`INSERT INTO playlist_climbs(playlist_id,climb_uuid,position) SELECT id,'old-climb',0 FROM playlists`;
    await client`INSERT INTO account_consolidation_import_aliases(former_user_id,provider,kind,external_id,canonical_resource_id,target_user_id,merge_id) VALUES('source','aurora','playlist',${frozenId},'retained-playlist','canonical','fixture-merge')`;
  });
  it('updates the retained identity and memberships on repeated exports without recreating it', async () => {
    const [original] = await client`SELECT id FROM playlists`;
    expect((await reimport()).circuits).toEqual({ imported: 1, skipped: 0, failed: 0 });
    expect((await reimport()).circuits).toEqual({ imported: 1, skipped: 0, failed: 0 });
    const rows = await client`SELECT id,uuid,name,description,color,aurora_id FROM playlists`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: original.id,
      uuid: 'retained-playlist',
      name: 'Training',
      description: 'Updated description',
      color: '#00FF00',
      aurora_id: frozenId,
    });
    expect(await client`SELECT climb_uuid,position FROM playlist_climbs ORDER BY position`).toEqual([
      { climb_uuid: 'new-climb', position: 0 },
      { climb_uuid: 'old-climb', position: 1 },
    ]);
    expect(await client`SELECT user_id,role FROM playlist_ownership`).toEqual([
      { user_id: 'canonical', role: 'owner' },
    ]);
  });
  it.each(['foreign-only', 'foreign-co-owner', 'unowned'] as const)(
    'refuses a mapped %s playlist without metadata or membership changes',
    async (mode) => {
      if (mode !== 'foreign-co-owner') await client`DELETE FROM playlist_ownership`;
      if (mode !== 'unowned')
        await client`INSERT INTO playlist_ownership(playlist_id,user_id,role) SELECT id,'foreign','owner' FROM playlists`;
      expect((await reimport()).circuits).toEqual({ imported: 0, skipped: 1, failed: 0 });
      expect((await client`SELECT description,color FROM playlists`)[0]).toMatchObject({
        description: 'Original description',
        color: '#000000',
      });
      expect(await client`SELECT climb_uuid FROM playlist_climbs`).toEqual([{ climb_uuid: 'old-climb' }]);
      expect((await client`SELECT count(*)::int AS count FROM playlists`)[0].count).toBe(1);
      if (mode === 'foreign-only' || mode === 'unowned')
        expect(
          (await client`SELECT count(*)::int AS count FROM playlist_ownership WHERE user_id='canonical'`)[0].count,
        ).toBe(0);
    },
  );
  it.each([false, true])('does not recreate a deleted resource (explicit tombstone=%s)', async (tombstone) => {
    await client`DELETE FROM playlists`;
    if (tombstone)
      await client`UPDATE account_consolidation_import_aliases SET canonical_resource_id=NULL,tombstoned=true`;
    expect((await reimport()).circuits).toEqual({ imported: 0, skipped: 1, failed: 0 });
    expect((await client`SELECT count(*)::int AS count FROM playlists`)[0].count).toBe(0);
  });
  it.each(['board', 'upstream-type'])('refuses a mapped resource with incompatible %s', async (kind) => {
    if (kind === 'board') await client`UPDATE playlists SET board_type='kilter'`;
    else await client`UPDATE playlists SET aurora_type='ascents'`;
    expect((await reimport()).circuits).toEqual({ imported: 0, skipped: 1, failed: 0 });
    expect((await client`SELECT description FROM playlists`)[0].description).toBe('Original description');
  });
  it('preserves existing memberships when reimported names cannot be resolved', async () => {
    expect((await reimport(['Unavailable climb'])).circuits.imported).toBe(1);
    expect(await client`SELECT climb_uuid FROM playlist_climbs`).toEqual([{ climb_uuid: 'old-climb' }]);
  });
});
