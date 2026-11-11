import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import * as schema from '@boardsesh/db/schema';
import { getWorkerDatabaseName } from '../../../__tests__/worker-db';
import { schemaSQL } from '../../../__tests__/schema-sql';
import { buildAccountConsolidationPlan } from '../planner';
import { evidenceFixture } from './fixtures';
import type { ConsolidationContext } from '../executor';
import {
  consolidateProfilePrivacy,
  createConsolidationProfileHandler,
  type ConsolidationPreimageArchive,
} from '../profile-handler';
import {
  combineConsolidatedSessionMetadata,
  createConsolidationSessionHandler,
  planConsolidatedInferredSessions,
  type ConsolidationSessionIdentity,
} from '../session-handler';
import { createConsolidationOwnershipHandler } from '../ownership-handler';
import { createConsolidationRelationshipHandler } from '../relationship-handler';

const databaseName = getWorkerDatabaseName('bs_consolidation_domains');
const adminUrl = (process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/postgres').replace(
  /\/[^/]+$/,
  '/postgres',
);
let admin: postgres.Sql;
let client: postgres.Sql;
let created = false;
const archives: { domain: string; preimages: Readonly<Record<string, unknown>> }[] = [];
const archive: ConsolidationPreimageArchive = async (_context, domain, preimages) => {
  archives.push({ domain, preimages });
};
const context: ConsolidationContext = (() => {
  const plan = buildAccountConsolidationPlan(
    evidenceFixture([
      { userId: 'target', email: 'review@example.test' },
      { userId: 'source', email: 'Review@example.test' },
    ]),
    [],
    { evidenceSha256: 'a'.repeat(64) },
  );
  return {
    batchId: 'synthetic-batch',
    mergeId: 'synthetic-merge',
    survivorUserId: 'target',
    sourceUserIds: ['source'],
    group: plan.groups[0],
  };
})();
function session(
  id: string,
  owner: string,
  extra: Partial<ConsolidationSessionIdentity> = {},
): ConsolidationSessionIdentity {
  return {
    id,
    origin: 'inferred',
    createdByUserId: owner,
    userEdited: false,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    name: null,
    goal: null,
    notes: null,
    ...extra,
  };
}
function profile(
  extra: Partial<typeof schema.userProfiles.$inferSelect> = {},
): typeof schema.userProfiles.$inferSelect {
  return {
    userId: 'target',
    isPrivate: false,
    privacyRevision: 1,
    privacyOnboardingVersion: 1,
    defaultSessionAudience: null,
    anonymousOnForeignBoards: false,
    displayName: 'Canonical display',
    avatarUrl: null,
    instagramUrl: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...extra,
  };
}

describe('consolidation domain decisions', () => {
  it('keeps canonical display choices while intersecting privacy and invalidating consent revisions', () => {
    const canonical = profile();
    const source = profile({
      userId: 'source',
      isPrivate: true,
      anonymousOnForeignBoards: true,
      defaultSessionAudience: 'only_me',
      privacyRevision: 4,
      displayName: 'Source display',
    });
    expect(consolidateProfilePrivacy([canonical, source], canonical)).toMatchObject({
      isPrivate: true,
      anonymousOnForeignBoards: true,
      defaultSessionAudience: 'only_me',
      privacyRevision: 5,
    });
    expect(consolidateProfilePrivacy([canonical, source], canonical)).not.toHaveProperty('displayName');
  });
  it('merges connected inferred sessions while keeping explicit sessions distinct', () => {
    const instructions = planConsolidatedInferredSessions(
      [
        session('old', 'source', { userEdited: true }),
        session('canonical', 'target'),
        session('party', 'source', { origin: 'explicit' }),
      ],
      [
        { id: 1n, sessionId: 'old', climbedAt: '2026-11-11 12:00:00' },
        { id: 2n, sessionId: 'canonical', climbedAt: '2026-11-11 13:00:00' },
        { id: 3n, sessionId: 'party', climbedAt: '2026-11-11 12:30:00' },
      ],
      'target',
    );
    expect(instructions).toMatchObject([{ retainedId: 'canonical', retiredIds: ['old'] }]);
    expect(JSON.stringify(instructions)).not.toContain('party');
  });
  it('refuses to split one legacy session across disconnected runs', () => {
    expect(() =>
      planConsolidatedInferredSessions(
        [session('old', 'source')],
        [
          { id: 1n, sessionId: 'old', climbedAt: '2026-11-11 00:00:00' },
          { id: 2n, sessionId: 'old', climbedAt: '2026-11-11 20:00:00' },
        ],
        'target',
      ),
    ).toThrow();
  });
  it('preserves source titles, goals and long Unicode notes without truncation', () => {
    const notes = 'β'.repeat(70000);
    const combined = combineConsolidatedSessionMetadata(
      session('canonical', 'target', { name: 'Keep this name', goal: 'Keep this goal', notes: 'Canonical notes' }),
      [session('old', 'source', { name: 'Original title', goal: 'Original goal', notes })],
    );
    expect(combined.name).toBe('Keep this name');
    expect(combined.goal).toBe('Keep this goal');
    expect(combined.notes).toContain('Original title');
    expect(combined.notes).toContain('Original goal');
    expect(combined.notes).toContain(notes);
  });
});

describe('real transaction consolidation domains', () => {
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
    archives.length = 0;
    await client.unsafe(
      'TRUNCATE users,board_sessions,boardsesh_ticks,comments,votes,feed_items,notifications,content_privacy,resource_privacy,resource_grants,user_board_mappings,aurora_credentials,provider_sync_controls,account_consolidation_session_aliases CASCADE',
    );
    await client`INSERT INTO users(id,email,name) VALUES ('target','review@example.test','Target'),('source','Review@example.test','Source'),('viewer','viewer@example.test','Viewer')`;
  });

  it('narrows pre-merge follower content before followers are combined and preserves display fields', async () => {
    await client`INSERT INTO user_profiles(user_id,display_name,is_private,privacy_revision) VALUES('target','Canonical display',false,1),('source','Source display',true,2)`;
    await client`INSERT INTO user_follows(follower_id,following_id) VALUES('viewer','target')`;
    await client`INSERT INTO boardsesh_ticks(uuid,user_id,board_type,climb_uuid,angle,status,climbed_at) VALUES('private-tick','source','tension','fixture-climb',40,'send','2026-11-11 12:00:00')`;
    await drizzle(client).transaction((transaction) =>
      createConsolidationProfileHandler({ archivePreimages: archive }).apply(transaction, context),
    );
    const [canonical] = await drizzle(client)
      .select()
      .from(schema.userProfiles)
      .where(eq(schema.userProfiles.userId, 'target'));
    expect(canonical).toMatchObject({ displayName: 'Canonical display', isPrivate: true, privacyRevision: 3 });
    const [policy] = await drizzle(client)
      .select()
      .from(schema.contentPrivacy)
      .where(eq(schema.contentPrivacy.entityId, 'private-tick'));
    expect(policy).toMatchObject({ ownerId: 'source', audience: 'only_me' });
    expect(archives.some((entry) => entry.domain === 'pre-merge-follower-privacy')).toBe(true);
  });

  it('preserves inferred metadata/social history and durable aliases in the real transaction', async () => {
    await client`INSERT INTO board_sessions(id,origin,created_by_user_id,status,name,goal,notes,anchor_tick_id) VALUES('canonical','inferred','target','ended','Canonical name','Canonical goal','Canonical notes',1),('old','inferred','source','ended','Original title','Original goal','Original notes',2)`;
    await client`INSERT INTO boardsesh_ticks(id,uuid,user_id,board_type,climb_uuid,angle,status,climbed_at,session_id) VALUES(1,'first','target','tension','fixture-climb',40,'send','2026-11-11 12:00:00','canonical'),(2,'second','source','tension','fixture-climb-2',40,'send','2026-11-11 13:00:00','old')`;
    await client`INSERT INTO comments(uuid,user_id,entity_type,entity_id,body) VALUES('comment-history','viewer','session','old','Preserve this comment')`;
    await client`INSERT INTO votes(user_id,entity_type,entity_id,value) VALUES('viewer','session','canonical',1),('viewer','session','old',-1)`;
    await client`INSERT INTO board_session_participants(session_id,user_id) VALUES('canonical','target'),('old','source')`;
    await drizzle(client).transaction((transaction) =>
      createConsolidationSessionHandler({ archivePreimages: archive }).apply(transaction, context),
    );
    const sessions = await drizzle(client).select().from(schema.boardSessions);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: 'canonical',
      name: 'Canonical name',
      goal: 'Canonical goal',
      createdByUserId: 'target',
    });
    expect(sessions[0]?.notes).toContain('Original title');
    expect(sessions[0]?.notes).toContain('Original goal');
    expect(sessions[0]?.notes).toContain('Original notes');
    expect(await client`SELECT entity_id,body FROM comments WHERE uuid='comment-history'`).toEqual([
      { entity_id: 'canonical', body: 'Preserve this comment' },
    ]);
    expect(await client`SELECT entity_id,value FROM votes`).toEqual([{ entity_id: 'canonical', value: 1 }]);
    expect(
      await client`SELECT retired_session_id,canonical_session_id FROM account_consolidation_session_aliases`,
    ).toEqual([{ retired_session_id: 'old', canonical_session_id: 'canonical' }]);
    expect(await client`SELECT DISTINCT session_id FROM boardsesh_ticks`).toEqual([{ session_id: 'canonical' }]);
  });

  it('refuses an unknown session reference and rolls back the merge instead of cascading it', async () => {
    await client`INSERT INTO board_sessions(id,origin,created_by_user_id,status,name) VALUES('canonical','inferred','target','ended','Canonical'),('old','inferred','source','ended','Original')`;
    await client`INSERT INTO boardsesh_ticks(uuid,user_id,board_type,climb_uuid,angle,status,climbed_at,session_id) VALUES('first','target','tension','fixture-climb',40,'send','2026-11-11 12:00:00','canonical'),('second','source','tension','fixture-climb-2',40,'send','2026-11-11 13:00:00','old')`;
    await client.unsafe(
      'CREATE TABLE unexpected_session_reference(session_id text REFERENCES board_sessions(id) ON DELETE CASCADE, note text)',
    );
    try {
      await client`INSERT INTO unexpected_session_reference VALUES('old','Must survive')`;
      await expect(
        drizzle(client).transaction((transaction) =>
          createConsolidationSessionHandler({ archivePreimages: archive }).apply(transaction, context),
        ),
      ).rejects.toMatchObject({ code: 'UNSAFE_PLAN' });
      expect(await client`SELECT id,created_by_user_id FROM board_sessions ORDER BY id`).toEqual([
        { id: 'canonical', created_by_user_id: 'target' },
        { id: 'old', created_by_user_id: 'source' },
      ]);
      expect(await client`SELECT note FROM unexpected_session_reference`).toEqual([{ note: 'Must survive' }]);
      expect(await client`SELECT count(*)::integer AS total FROM account_consolidation_session_aliases`).toEqual([
        { total: 0 },
      ]);
    } finally {
      await client.unsafe('DROP TABLE unexpected_session_reference');
    }
  });

  it('refuses distinct saved walls that happen to use the same manufacturer serial', async () => {
    await client`INSERT INTO user_boards(uuid,slug,owner_id,board_type,layout_id,size_id,set_ids,name,serial_number) VALUES('wall-one','wall-one','target','tension',1,1,'1','First wall','12345'),('wall-two','wall-two','source','tension',1,1,'1','Other wall','12345')`;
    await expect(
      drizzle(client).transaction((transaction) =>
        createConsolidationOwnershipHandler({
          archivePreimages: archive,
          enqueueDerivedStats: async () => {},
          enqueueProviderSync: async () => {},
        }).apply(transaction, context),
      ),
    ).rejects.toMatchObject({ code: 'UNSAFE_PLAN' });
    expect(await client`SELECT owner_id,serial_number FROM user_boards ORDER BY id`).toEqual([
      { owner_id: 'target', serial_number: '12345' },
      { owner_id: 'source', serial_number: '12345' },
    ]);
  });

  it('refuses different provider identities without deleting either credential', async () => {
    await client`INSERT INTO user_board_mappings(user_id,board_type,board_user_id) VALUES('target','tension',42),('source','tension',99)`;
    await client`INSERT INTO aurora_credentials(user_id,board_type,aurora_user_id,encrypted_password) VALUES('target','tension',42,'canonical-secret-canary'),('source','tension',99,'source-secret-canary')`;
    await expect(
      drizzle(client).transaction((transaction) =>
        createConsolidationOwnershipHandler({
          archivePreimages: archive,
          enqueueDerivedStats: async () => {},
          enqueueProviderSync: async () => {},
        }).apply(transaction, context),
      ),
    ).rejects.toMatchObject({ code: 'UNSAFE_PLAN' });
    expect(await client`SELECT user_id FROM aurora_credentials ORDER BY user_id`).toEqual([
      { user_id: 'source' },
      { user_id: 'target' },
    ]);
    expect(await client`SELECT count(*)::integer AS total FROM provider_sync_controls`).toEqual([{ total: 0 }]);
  });

  it('coalesces canonical favorites and follows while preserving conservative grants', async () => {
    await client`INSERT INTO user_favorites(user_id,board_name,climb_uuid,angle) VALUES('target','tension','same-climb',40),('source','tension','same-climb',40)`;
    await client`INSERT INTO user_follows(follower_id,following_id) VALUES('target','source'),('source','target'),('viewer','target'),('viewer','source')`;
    await client`INSERT INTO resource_grants(kind,resource_id,user_id,status) VALUES('session','grant-target','target','approved'),('session','grant-target','source','revoked')`;
    await drizzle(client).transaction((transaction) =>
      createConsolidationRelationshipHandler({
        archivePreimages: async (group, preimages) => archive(group, 'relationships', preimages),
      }).apply(transaction, context),
    );
    expect(await client`SELECT user_id,climb_uuid FROM user_favorites`).toEqual([
      { user_id: 'target', climb_uuid: 'same-climb' },
    ]);
    expect(await client`SELECT follower_id,following_id FROM user_follows`).toEqual([
      { follower_id: 'viewer', following_id: 'target' },
    ]);
    expect(await client`SELECT user_id,status FROM resource_grants`).toEqual([
      { user_id: 'target', status: 'revoked' },
    ]);
  });

  it('keeps the canonical vote when actor consolidation creates an opposing vote collision', async () => {
    await client`INSERT INTO votes(user_id,entity_type,entity_id,value,created_at) VALUES('target','session','same-session',1,'2026-01-01'),('source','session','same-session',-1,'2026-11-11')`;
    await drizzle(client).transaction((transaction) =>
      createConsolidationRelationshipHandler({
        archivePreimages: async (group, preimages) => archive(group, 'relationships', preimages),
      }).apply(transaction, context),
    );
    expect(await client`SELECT user_id,value FROM votes`).toEqual([{ user_id: 'target', value: 1 }]);
  });

  it('invalidates canonical derived percentiles and queues recomputation while retaining source history', async () => {
    await client`INSERT INTO user_climb_percentiles(user_id,total_distinct_climbs,percentile,total_active_users) VALUES('target',10,50,100),('source',20,75,100)`;
    let recomputes = 0;
    await drizzle(client).transaction((transaction) =>
      createConsolidationOwnershipHandler({
        archivePreimages: archive,
        enqueueDerivedStats: async () => {
          recomputes++;
        },
        enqueueProviderSync: async () => {},
      }).apply(transaction, context),
    );
    expect(await client`SELECT user_id,total_distinct_climbs FROM user_climb_percentiles`).toEqual([
      { user_id: 'source', total_distinct_climbs: 20 },
    ]);
    expect(recomputes).toBe(1);
  });

  it('moves playlist ownership without duplicating an equal-role existing owner', async () => {
    await client`INSERT INTO playlists(uuid,board_type,name) VALUES('shared-list','tension','Shared list')`;
    await client`INSERT INTO playlist_ownership(playlist_id,user_id,role) SELECT id,'target','owner' FROM playlists`;
    await client`INSERT INTO playlist_ownership(playlist_id,user_id,role) SELECT id,'source','owner' FROM playlists`;
    await drizzle(client).transaction((transaction) =>
      createConsolidationRelationshipHandler({
        archivePreimages: async (group, preimages) => archive(group, 'relationships', preimages),
      }).apply(transaction, context),
    );
    expect(await client`SELECT user_id,role FROM playlist_ownership`).toEqual([{ user_id: 'target', role: 'owner' }]);
  });

  it('rotates provider job fences and preserves canonical encrypted credentials without selecting secrets into archives', async () => {
    await client`INSERT INTO user_board_mappings(user_id,board_type,board_user_id) VALUES('target','tension',42),('source','tension',42)`;
    await client`INSERT INTO aurora_credentials(user_id,board_type,aurora_user_id,encrypted_password) VALUES('target','tension',42,'canonical-secret-canary'),('source','tension',42,'source-secret-canary')`;
    const queued: string[] = [];
    await drizzle(client).transaction((transaction) =>
      createConsolidationOwnershipHandler({
        archivePreimages: archive,
        enqueueDerivedStats: async () => {},
        enqueueProviderSync: async (_transaction, _context, link) => {
          queued.push(link.linkGeneration);
        },
      }).apply(transaction, context),
    );
    expect(await client`SELECT user_id,encrypted_password FROM aurora_credentials`).toEqual([
      { user_id: 'target', encrypted_password: 'canonical-secret-canary' },
    ]);
    expect(
      await client`SELECT user_id,linked,active_run_id,pending_run_id FROM provider_sync_controls ORDER BY user_id`,
    ).toEqual([
      { user_id: 'source', linked: false, active_run_id: null, pending_run_id: null },
      { user_id: 'target', linked: true, active_run_id: null, pending_run_id: null },
    ]);
    expect(queued).toHaveLength(1);
    expect(
      JSON.stringify(archives, (_, entry: unknown) => (typeof entry === 'bigint' ? entry.toString() : entry)),
    ).not.toContain('secret-canary');
  });
});
