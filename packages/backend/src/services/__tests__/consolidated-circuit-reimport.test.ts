import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import {
  buildCoordinateMap,
  convertHoldsToFrames,
  generateClimbImportUuid,
  generateJsonImportAuroraId,
  generateJsonImportCircuitAuroraId,
  importJsonExportData,
  normalizeTimestamp,
} from '@boardsesh/aurora-sync/json-import';
import { LAYOUTS } from '@boardsesh/board-constants/product-sizes';
import { schemaSQL } from '../../__tests__/schema-sql';
import { getWorkerDatabaseName } from '../../__tests__/worker-db';

const adminUrl = (process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/postgres').replace(
  /\/[^/]+$/,
  '/postgres',
);
const databaseName = getWorkerDatabaseName('bs_consolidated_circuits');
const createdAt = '2026-01-01T00:00:00.000Z';
const frozenId = generateJsonImportCircuitAuroraId('source', 'tension', 'Training', createdAt);
const draftName = 'Working draft';
const draftLayout = LAYOUTS.tension[9];
const originalDraftUuid = generateClimbImportUuid('source', 'tension', draftLayout.id, draftName, createdAt);
const draftCoordinates = buildCoordinateMap('tension', draftLayout.id);
const [[firstCoordinate], [secondCoordinate]] = [...draftCoordinates];
const [firstX, firstY] = firstCoordinate.split(',').map(Number);
const [secondX, secondY] = secondCoordinate.split(',').map(Number);
const originalHolds = [{ x: firstX, y: firstY, role: 'start' }];
const changedHolds = [...originalHolds, { x: secondX, y: secondY, role: 'finish' }];
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
function reimportDraft(description = 'Updated draft description') {
  return importJsonExportData(
    drizzle(client),
    'canonical',
    'tension',
    {
      user: { username: 'fixture' },
      ascents: [],
      attempts: [],
      likes: [],
      circuits: [],
      climbs: [
        {
          name: draftName,
          layout: draftLayout.name,
          created_at: createdAt,
          is_draft: true,
          description,
          holds: changedHolds,
        },
      ],
    },
    undefined,
    { skipFinalization: true },
  );
}
async function seedRetainedDraft() {
  const frames = convertHoldsToFrames(originalHolds, draftCoordinates, 'tension');
  await client`INSERT INTO board_climbs(uuid,user_id,board_type,layout_id,setter_username,name,description,frames,frames_count,is_draft,is_listed,edge_left,edge_right,edge_bottom,edge_top,created_at)
    VALUES('retained-draft','canonical','tension',${draftLayout.id},'fixture',${draftName},'Original draft description',${frames},1,true,false,0,100,0,150,${createdAt})`;
  await client`INSERT INTO account_consolidation_import_aliases(former_user_id,provider,kind,external_id,canonical_resource_id,target_user_id,merge_id)
    VALUES('source','aurora','climb',${originalDraftUuid},'retained-draft','canonical','fixture-merge')`;
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
  it('refreshes changed holds and description on a retained draft without recreating it', async () => {
    await seedRetainedDraft();
    expect((await reimportDraft()).climbs).toEqual({ imported: 1, skipped: 0, failed: 0 });
    expect((await reimportDraft()).climbs).toEqual({ imported: 1, skipped: 0, failed: 0 });
    expect(
      await client`SELECT uuid,user_id,board_type,layout_id,is_draft,description,frames FROM board_climbs WHERE user_id='canonical'`,
    ).toEqual([
      {
        uuid: 'retained-draft',
        user_id: 'canonical',
        board_type: 'tension',
        layout_id: draftLayout.id,
        is_draft: true,
        description: 'Updated draft description',
        frames: convertHoldsToFrames(changedHolds, draftCoordinates, 'tension'),
      },
    ]);
  });
  it('refreshes no-match draft characteristics and retains other climb tags', async () => {
    await seedRetainedDraft();
    await client`UPDATE board_climbs SET characteristics=ARRAY['campus'] WHERE uuid='retained-draft'`;
    expect((await reimportDraft('No match. Updated draft description')).climbs.imported).toBe(1);
    expect(
      (await client`SELECT characteristics FROM board_climbs WHERE uuid='retained-draft'`)[0].characteristics,
    ).toEqual(['campus', 'no_match']);
    expect((await reimportDraft()).climbs.imported).toBe(1);
    expect(
      (await client`SELECT characteristics FROM board_climbs WHERE uuid='retained-draft'`)[0].characteristics,
    ).toEqual(['campus']);
  });
  it.each(['deleted', 'foreign', 'board', 'layout', 'published'] as const)(
    'does not overwrite or recreate a mapped draft whose target is %s',
    async (target) => {
      await seedRetainedDraft();
      if (target === 'deleted') await client`DELETE FROM board_climbs WHERE uuid='retained-draft'`;
      if (target === 'foreign') await client`UPDATE board_climbs SET user_id='foreign' WHERE uuid='retained-draft'`;
      if (target === 'board') await client`UPDATE board_climbs SET board_type='kilter' WHERE uuid='retained-draft'`;
      if (target === 'layout') await client`UPDATE board_climbs SET layout_id=2 WHERE uuid='retained-draft'`;
      if (target === 'published') await client`UPDATE board_climbs SET is_draft=false WHERE uuid='retained-draft'`;
      const before = await client`SELECT * FROM board_climbs ORDER BY uuid`;
      expect((await reimportDraft()).climbs).toEqual({ imported: 0, skipped: 1, failed: 0 });
      expect(await client`SELECT * FROM board_climbs ORDER BY uuid`).toEqual(before);
    },
  );
  it('keeps a tombstoned draft deleted', async () => {
    await seedRetainedDraft();
    await client`DELETE FROM board_climbs WHERE uuid='retained-draft'`;
    await client`UPDATE account_consolidation_import_aliases SET canonical_resource_id=NULL,tombstoned=true WHERE kind='climb'`;
    expect((await reimportDraft()).climbs).toEqual({ imported: 0, skipped: 1, failed: 0 });
    expect(await client`SELECT uuid FROM board_climbs WHERE name=${draftName}`).toEqual([]);
  });
  it.each(['ascents', 'bids'] as const)(
    'does not resurrect tombstoned %s when both the owner and climb were remapped',
    async (kind) => {
      const originalClimbUuid = generateClimbImportUuid('source', 'tension', 1, 'New climb', createdAt);
      const climbedAt = '2026-01-02T12:00:00.000Z';
      const originalTickHash = generateJsonImportAuroraId(
        'source',
        originalClimbUuid,
        40,
        normalizeTimestamp(climbedAt),
        kind,
      );
      await client`INSERT INTO account_consolidation_import_aliases(former_user_id,provider,kind,external_id,canonical_resource_id,target_user_id,merge_id,tombstoned) VALUES
        ('source','aurora','climb',${originalClimbUuid},'new-climb','canonical','fixture-merge',false),
        ('source','aurora','tick',${originalTickHash},NULL,'canonical','fixture-merge',true)`;
      const record = { climb: 'New climb', angle: 40, count: 1, climbed_at: climbedAt, created_at: climbedAt };
      const exportRows = {
        user: { username: 'fixture' },
        likes: [],
        climbs: [],
        circuits: [],
        ascents: kind === 'ascents' ? [record] : [],
        attempts: kind === 'bids' ? [record] : [],
      };
      for (let repetition = 0; repetition < 2; repetition++) {
        const imported = await importJsonExportData(drizzle(client), 'canonical', 'tension', exportRows, undefined, {
          skipFinalization: true,
        });
        expect(kind === 'ascents' ? imported.ascents : imported.attempts).toEqual({
          imported: 0,
          skipped: 1,
          failed: 0,
        });
      }
      expect(await client`SELECT uuid FROM boardsesh_ticks`).toEqual([]);
    },
  );
});
