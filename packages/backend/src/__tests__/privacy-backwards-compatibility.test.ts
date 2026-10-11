import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { and, eq, sql } from 'drizzle-orm';
import { buildSchema, graphql } from 'graphql';
import { playlistVisibilityCondition } from '@boardsesh/db/queries';
import * as schema from '@boardsesh/db/schema';
import { typeDefs, type ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { playlistMutations } from '../graphql/resolvers/playlists/mutations';
import { socialBoardMutations } from '../graphql/resolvers/social/boards';
import { sessionEditMutations } from '../graphql/resolvers/social/session-mutations';
import { sessionMutations } from '../graphql/resolvers/sessions/mutations';
import { syncQueries } from '../graphql/resolvers/sync/queries';
import { privacyMutations } from '../graphql/resolvers/privacy';
import { canViewContent, setContentPrivacy } from '../services/privacy';
import { ensureSessionRecordExists } from '../services/room-manager/client-lifecycle';
import { resetAllRateLimits } from '../utils/rate-limiter';

const ownerId = 'privacy-compat-owner';
const collaboratorId = 'privacy-compat-collaborator';
const privateOwnerId = 'privacy-compat-private-owner';
const context = { userId: ownerId, isAuthenticated: true, connectionId: 'privacy-compat' } as ConnectionContext;

beforeAll(async () => {
  await db
    .insert(schema.users)
    .values([ownerId, collaboratorId, privateOwnerId].map((id) => ({ id, email: `${id}@test.com` })));
  await db.insert(schema.userProfiles).values({ userId: ownerId, privacyRevision: 3 });
  await db
    .insert(schema.userProfiles)
    .values({ userId: privateOwnerId, isPrivate: true, defaultSessionAudience: 'followers' });
});
beforeEach(() => resetAllRateLimits());
afterEach(() => vi.unstubAllEnvs());

async function insertPlaylist(uuid: string, audience: 'public' | 'followers' | 'only_me') {
  const [playlist] = await db
    .insert(schema.playlists)
    .values({ uuid, boardType: 'kilter', name: uuid, isPublic: audience === 'public' })
    .returning();
  await db.insert(schema.playlistOwnership).values([
    { playlistId: playlist.id, userId: ownerId, role: 'owner' },
    { playlistId: playlist.id, userId: collaboratorId, role: 'editor' },
  ]);
  await db.insert(schema.contentPrivacy).values({
    entityType: 'playlist',
    entityId: uuid,
    ownerId,
    audience,
    publicConsentRevision: audience === 'public' ? 3 : null,
  });
}

async function playlistReadable(uuid: string, viewerId?: string) {
  const rows = await db
    .select({ uuid: schema.playlists.uuid })
    .from(schema.playlists)
    .where(and(eq(schema.playlists.uuid, uuid), playlistVisibilityCondition(viewerId)));
  return rows.length > 0;
}

describe('installed-client privacy contracts', () => {
  it.each(['0', '1'])('honors the legacy Private switch with controls enabled=%s', async (flag) => {
    vi.stubEnv('BOARDSESH_PRIVACY_ENABLED', flag);
    const uuid = `privacy-compat-public-${flag}`;
    await insertPlaylist(uuid, 'public');
    expect(await playlistReadable(uuid)).toBe(true);
    await playlistMutations.updatePlaylist(null, { input: { playlistId: uuid, isPublic: false } }, context);
    expect(await playlistReadable(uuid)).toBe(false);
    expect(await playlistReadable(uuid, ownerId)).toBe(true);
    // The old private-playlist switch retained explicitly invited editors.
    expect(await playlistReadable(uuid, collaboratorId)).toBe(true);
  });

  it.each(['followers', 'only_me'] as const)(
    'preserves a newer %s policy across old edits and Public switches',
    async (audience) => {
      const uuid = `privacy-compat-restricted-${audience}`;
      await insertPlaylist(uuid, audience);
      for (const patch of [{ name: 'Old-client rename' }, { isPublic: false }, { isPublic: true }]) {
        await playlistMutations.updatePlaylist(null, { input: { playlistId: uuid, ...patch } }, context);
        expect(await playlistReadable(uuid)).toBe(false);
        const [policy] = await db
          .select()
          .from(schema.contentPrivacy)
          .where(and(eq(schema.contentPrivacy.entityType, 'playlist'), eq(schema.contentPrivacy.entityId, uuid)));
        expect(policy.audience).toBe(audience);
      }
    },
  );

  it.each(['followers', 'invite_only', 'only_me', 'unlisted'] as const)(
    'keeps a modern %s board and its location protected from old full-form edits',
    async (audience) => {
      const uuid = randomUUID();
      await db.insert(schema.userBoards).values({
        uuid,
        slug: uuid,
        ownerId,
        boardType: 'kilter',
        layoutId: 1,
        sizeId: 1,
        setIds: '1',
        name: 'Protected wall',
        isPublic: false,
        isUnlisted: audience === 'unlisted',
        hideLocation: true,
      });
      await db
        .insert(schema.resourcePrivacy)
        .values({ kind: 'board', resourceId: uuid, ownerId, audience, locationAudience: 'members' });
      // An unchanged full edit must not silently narrow followers/location to Only me either.
      await socialBoardMutations.updateBoard(
        null,
        {
          input: {
            boardUuid: uuid,
            name: 'Renamed wall',
            isPublic: false,
            isUnlisted: audience === 'unlisted',
            hideLocation: true,
          },
        },
        context,
      );
      // A stale pre-privacy form still carries Public and Show location.
      const updated = await socialBoardMutations.updateBoard(
        null,
        {
          input: {
            boardUuid: uuid,
            name: 'Stale form rename',
            isPublic: true,
            isUnlisted: false,
            hideLocation: false,
          },
        },
        context,
      );
      expect(updated).toMatchObject({
        name: 'Stale form rename',
        isPublic: false,
        isUnlisted: audience === 'unlisted',
        hideLocation: true,
      });
      const [policy] = await db
        .select()
        .from(schema.resourcePrivacy)
        .where(and(eq(schema.resourcePrivacy.kind, 'board'), eq(schema.resourcePrivacy.resourceId, uuid)));
      expect(policy).toMatchObject({ audience, locationAudience: 'members', revision: 0 });
    },
  );

  it.each(['followers', 'invite_only', 'only_me'] as const)(
    'keeps a modern %s session protected from an old Public edit',
    async (audience) => {
      const sessionId = randomUUID();
      await db
        .insert(schema.boardSessions)
        .values({ id: sessionId, createdByUserId: ownerId, boardPath: 'kilter/1/1/1/40', isPublic: false });
      await db.insert(schema.resourcePrivacy).values({ kind: 'session', resourceId: sessionId, ownerId, audience });
      const updated = await sessionEditMutations.updateSession(
        null,
        { input: { sessionId, name: 'Old form rename', isPublic: true } },
        context,
      );
      expect(updated).toMatchObject({ name: 'Old form rename', isPublic: false });
      const [policy] = await db
        .select()
        .from(schema.resourcePrivacy)
        .where(and(eq(schema.resourcePrivacy.kind, 'session'), eq(schema.resourcePrivacy.resourceId, sessionId)));
      expect(policy).toMatchObject({ audience, revision: 0 });
    },
  );

  it.each(['0', '1'])(
    'retains legacy board creation and visibility roundtrips with controls enabled=%s',
    async (flag) => {
      vi.stubEnv('BOARDSESH_PRIVACY_ENABLED', flag);
      const board = await socialBoardMutations.createBoard(
        null,
        {
          input: {
            boardType: 'moonboard',
            layoutId: 3,
            sizeId: 1,
            setIds: '5,6,7,8,9,10',
            name: `Legacy board ${flag}`,
            isPublic: true,
            hideLocation: false,
            allowDuplicateConfig: true,
          },
        },
        context,
      );
      for (const isPublic of [false, true]) {
        const updated = await socialBoardMutations.updateBoard(
          null,
          {
            input: {
              boardUuid: board.uuid,
              isPublic,
              hideLocation: !isPublic,
            },
          },
          context,
        );
        expect(updated).toMatchObject({ isPublic, hideLocation: !isPublic });
      }
      expect(
        await db
          .select()
          .from(schema.resourcePrivacy)
          .where(and(eq(schema.resourcePrivacy.kind, 'board'), eq(schema.resourcePrivacy.resourceId, board.uuid))),
      ).toEqual([]);
    },
  );

  it.each(['0', '1'])(
    'creates a public board with its location hidden and no policy when an old client sends no visibility, controls enabled=%s',
    async (flag) => {
      vi.stubEnv('BOARDSESH_PRIVACY_ENABLED', flag);
      const board = await socialBoardMutations.createBoard(
        null,
        {
          input: {
            boardType: 'moonboard',
            layoutId: 3,
            sizeId: 1,
            setIds: '5,6,7,8,9,10',
            name: `Default board ${flag}`,
            allowDuplicateConfig: true,
          },
        },
        context,
      );
      const [stored] = await db.select().from(schema.userBoards).where(eq(schema.userBoards.uuid, board.uuid));
      expect(stored).toMatchObject({ isPublic: true, isUnlisted: false, hideLocation: true });
      expect(
        await db
          .select()
          .from(schema.resourcePrivacy)
          .where(and(eq(schema.resourcePrivacy.kind, 'board'), eq(schema.resourcePrivacy.resourceId, board.uuid))),
      ).toEqual([]);
    },
  );

  it('keeps an old client that asks for a private board private', async () => {
    const board = await socialBoardMutations.createBoard(
      null,
      {
        input: {
          boardType: 'moonboard',
          layoutId: 3,
          sizeId: 1,
          setIds: '5,6,7,8,9,10',
          name: 'Private legacy board',
          isPublic: false,
          isUnlisted: true,
          allowDuplicateConfig: true,
        },
      },
      context,
    );
    const [stored] = await db.select().from(schema.userBoards).where(eq(schema.userBoards.uuid, board.uuid));
    expect(stored).toMatchObject({ isPublic: false, isUnlisted: false, hideLocation: true });
    // Legacy booleans only: no policy row, so the old Public switch still works.
    expect(
      await db
        .select()
        .from(schema.resourcePrivacy)
        .where(and(eq(schema.resourcePrivacy.kind, 'board'), eq(schema.resourcePrivacy.resourceId, board.uuid))),
    ).toEqual([]);
  });

  it('stores a followers location as invited people, on create and on update', async () => {
    vi.stubEnv('BOARDSESH_PRIVACY_ENABLED', '1');
    const board = await socialBoardMutations.createBoard(
      null,
      {
        input: {
          boardType: 'moonboard',
          layoutId: 3,
          sizeId: 1,
          setIds: '5,6,7,8,9,10',
          name: 'Followers location board',
          audience: 'public',
          locationAudience: 'followers',
          allowDuplicateConfig: true,
        },
      },
      context,
    );
    const policyFor = async () => {
      const [policy] = await db
        .select()
        .from(schema.resourcePrivacy)
        .where(and(eq(schema.resourcePrivacy.kind, 'board'), eq(schema.resourcePrivacy.resourceId, board.uuid)));
      return policy;
    };
    expect(await policyFor()).toMatchObject({ audience: 'public', locationAudience: 'members' });

    await privacyMutations.updateResourcePrivacy(
      null,
      { input: { kind: 'board', resourceId: board.uuid, audience: 'public', locationAudience: 'public' } },
      context,
    );
    expect(await policyFor()).toMatchObject({ locationAudience: 'public' });
    await privacyMutations.updateResourcePrivacy(
      null,
      { input: { kind: 'board', resourceId: board.uuid, audience: 'public', locationAudience: 'followers' } },
      context,
    );
    expect(await policyFor()).toMatchObject({ locationAudience: 'members' });
    const [stored] = await db.select().from(schema.userBoards).where(eq(schema.userBoards.uuid, board.uuid));
    expect(stored.hideLocation).toBe(true);
  });

  it.each(['0', '1'])(
    'retains old session creation and visibility roundtrips with controls enabled=%s',
    async (flag) => {
      vi.stubEnv('BOARDSESH_PRIVACY_ENABLED', flag);
      const session = await sessionMutations.createSession(
        null,
        {
          input: {
            boardPath: 'kilter/1/1/1/40',
            latitude: 0,
            longitude: 0,
            discoverable: false,
            isPublic: true,
          },
        },
        { ...context, transport: 'http' },
      );
      for (const isPublic of [false, true]) {
        expect(
          await sessionEditMutations.updateSession(null, { input: { sessionId: session.id, isPublic } }, context),
        ).toMatchObject({ isPublic });
      }
      expect(
        await db
          .select()
          .from(schema.resourcePrivacy)
          .where(and(eq(schema.resourcePrivacy.kind, 'session'), eq(schema.resourcePrivacy.resourceId, session.id))),
      ).toEqual([]);
      // The old WebSocket lazy-persistence path must carry the same contract.
      const lazyId = randomUUID();
      await ensureSessionRecordExists(lazyId, 'kilter/1/1/1/40', ownerId, undefined, false);
      expect(
        await sessionEditMutations.updateSession(null, { input: { sessionId: lazyId, isPublic: true } }, context),
      ).toMatchObject({ isPublic: true });
    },
  );

  // The account's restrictive defaults come from its own profile row (set in
  // beforeAll), never from the controls flag: new accounts start public.
  it.each(['0', '1'])(
    'protects an account that chose restrictive defaults on both old session creation paths with controls enabled=%s',
    async (flag) => {
      vi.stubEnv('BOARDSESH_PRIVACY_ENABLED', flag);
      const privateContext = { ...context, userId: privateOwnerId, transport: 'http' as const };
      const session = await sessionMutations.createSession(
        null,
        {
          input: {
            boardPath: 'kilter/1/1/1/40',
            latitude: 0,
            longitude: 0,
            discoverable: false,
            isPublic: true,
          },
        },
        privateContext,
      );
      const lazyId = randomUUID();
      await ensureSessionRecordExists(lazyId, 'kilter/1/1/1/40', privateOwnerId, undefined, true);
      for (const sessionId of [session.id, lazyId]) {
        expect(
          await sessionEditMutations.updateSession(null, { input: { sessionId, isPublic: true } }, privateContext),
        ).toMatchObject({ isPublic: false });
        const [policy] = await db
          .select()
          .from(schema.resourcePrivacy)
          .where(and(eq(schema.resourcePrivacy.kind, 'session'), eq(schema.resourcePrivacy.resourceId, sessionId)));
        expect(policy.audience).toBe('followers');
      }
    },
  );

  it('lets the legacy switch narrow a modern public session to unlisted', async () => {
    const sessionId = randomUUID();
    await db
      .insert(schema.boardSessions)
      .values({ id: sessionId, createdByUserId: ownerId, boardPath: 'kilter/1/1/1/40', isPublic: true });
    await db
      .insert(schema.resourcePrivacy)
      .values({ kind: 'session', resourceId: sessionId, ownerId, audience: 'public' });
    await sessionEditMutations.updateSession(null, { input: { sessionId, isPublic: false } }, context);
    const [policy] = await db
      .select()
      .from(schema.resourcePrivacy)
      .where(and(eq(schema.resourcePrivacy.kind, 'session'), eq(schema.resourcePrivacy.resourceId, sessionId)));
    // Private on an old client means off the listings; the link still joins.
    expect(policy.audience).toBe('unlisted');
  });

  it('does not replace an Only me account default with old Private boolean semantics', async () => {
    const userId = 'privacy-compat-only-me-owner';
    await db.insert(schema.users).values({ id: userId, email: `${userId}@test.com` });
    await db.insert(schema.userProfiles).values({ userId, isPrivate: true, defaultSessionAudience: 'only_me' });
    const session = await sessionMutations.createSession(
      null,
      {
        input: {
          boardPath: 'kilter/1/1/1/40',
          latitude: 0,
          longitude: 0,
          discoverable: false,
          isPublic: false,
        },
      },
      { ...context, userId, transport: 'http' },
    );
    const lazyId = randomUUID();
    await ensureSessionRecordExists(lazyId, 'kilter/1/1/1/40', userId, undefined, false);
    for (const sessionId of [session.id, lazyId]) {
      const [policy] = await db
        .select()
        .from(schema.resourcePrivacy)
        .where(and(eq(schema.resourcePrivacy.kind, 'session'), eq(schema.resourcePrivacy.resourceId, sessionId)));
      expect(policy.audience).toBe('only_me');
    }
  });

  it.each(['public', 'followers', 'only_me'] as const)(
    'commits a queued %s publication after controls are disabled',
    async (audience) => {
      vi.stubEnv('BOARDSESH_PRIVACY_ENABLED', '0');
      const uuid = `privacy-compat-queued-${audience}`;
      await db.transaction(async (transaction) => {
        await transaction.insert(schema.boardseshTicks).values({
          uuid,
          userId: ownerId,
          climbUuid: 'compat-climb',
          boardType: 'kilter',
          angle: 40,
          status: 'send',
          climbedAt: '2026-01-01T10:00:00Z',
        });
        await setContentPrivacy(transaction, ownerId, 'tick', uuid, audience, 3);
      });
      expect(await canViewContent(null, 'tick', uuid, ownerId)).toBe(audience === 'public');
      const [tick] = await db.select().from(schema.boardseshTicks).where(eq(schema.boardseshTicks.uuid, uuid));
      expect(tick).toBeDefined();
    },
  );

  it('keeps stale public consent and settings controls blocked during rollback', async () => {
    vi.stubEnv('BOARDSESH_PRIVACY_ENABLED', '0');
    await expect(
      db.transaction((transaction) =>
        setContentPrivacy(transaction, ownerId, 'tick', 'privacy-compat-stale', 'public', 2),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'PRIVACY_REVISION_CONFLICT' } });
    await expect(
      privacyMutations.updatePrivacySettings(null, { input: { isPrivate: false } }, context),
    ).rejects.toMatchObject({ extensions: { code: 'PRIVACY_UNAVAILABLE' } });
  });
});

// The shipped 2.5.0 / 2.6.0 fleet pulls board data with NO `audience` argument.
// The argument is additive, so the request still executes and the document it
// returns has the same keys in the same order. What the publication rule
// changed is WHICH climbs that request returns, and this suite states exactly
// that, per climb:
//
//  - unchanged: every published, listed climb the caller already got, and the
//    caller's own drafts and unlisted climbs;
//  - regained: a published, listed climb the old privacy check withheld (set by
//    a private account, or carrying a narrowed audience);
//  - lost: a draft or an unlisted climb the caller does not own.
//
// The stats and grades rows follow their climb. The pages are compared as
// serialized JSON, so a reordered key or a changed value fails here.
describe('installed-client sync pulls without an audience', () => {
  const BOARD_TYPE = 'tension';
  const LAYOUT_ID = 7701;
  const scope = { boardType: BOARD_TYPE, layoutId: LAYOUT_ID, sizeId: null, cursor: null, limit: 500 };

  type CompatClimb = {
    uuid: string;
    userId: string | null;
    authored?: true;
    isDraft?: true;
    unlisted?: true;
    seq: number;
    /** What the rule did to this row in `ownerId`'s pull. */
    forOwner: 'unchanged' | 'regained' | 'lost';
  };

  const climbs: CompatClimb[] = [
    { uuid: 'compat-sync-imported', userId: null, seq: 910001, forOwner: 'unchanged' },
    { uuid: 'compat-sync-own', userId: ownerId, seq: 910002, forOwner: 'unchanged' },
    // Published by an account whose profile is private.
    { uuid: 'compat-sync-private', userId: privateOwnerId, seq: 910003, forOwner: 'regained' },
    // The account is gone; the climb it published stays public.
    { uuid: 'compat-sync-deleted-public', userId: null, authored: true, seq: 910004, forOwner: 'unchanged' },
    // Published, with an item audience narrowed to its author alone.
    { uuid: 'compat-sync-orphan-policy', userId: null, seq: 910005, forOwner: 'regained' },
    { uuid: 'compat-sync-own-draft', userId: ownerId, isDraft: true, seq: 910006, forOwner: 'unchanged' },
    { uuid: 'compat-sync-own-unlisted', userId: ownerId, unlisted: true, seq: 910007, forOwner: 'unchanged' },
    // A public account's draft and unlisted climb: the account audience alone
    // used to show both to every signed-in caller.
    { uuid: 'compat-sync-other-draft', userId: collaboratorId, isDraft: true, seq: 910008, forOwner: 'lost' },
    { uuid: 'compat-sync-other-unlisted', userId: collaboratorId, unlisted: true, seq: 910009, forOwner: 'lost' },
    { uuid: 'compat-sync-ownerless-draft', userId: null, isDraft: true, seq: 910010, forOwner: 'lost' },
    { uuid: 'compat-sync-ownerless-unlisted', userId: null, unlisted: true, seq: 910011, forOwner: 'lost' },
  ];

  const isPublic = (climb: CompatClimb) => !climb.isDraft && !climb.unlisted;
  const deliveredTo = (viewerId: string) => climbs.filter((climb) => isPublic(climb) || climb.userId === viewerId);

  beforeAll(async () => {
    await db.execute(sql`DELETE FROM board_climb_grades WHERE climb_uuid LIKE 'compat-sync-%'`);
    for (const climb of climbs) {
      await db.execute(sql`
        INSERT INTO board_climbs
          (uuid, board_type, layout_id, name, is_listed, is_draft, compatible_size_ids, user_id,
           is_boardsesh_authored, updated_at, sync_seq)
        VALUES
          (${climb.uuid}, ${BOARD_TYPE}, ${LAYOUT_ID}, ${climb.uuid}, ${!climb.unlisted}, ${climb.isDraft === true},
           '{5}'::int[], ${climb.userId}, ${climb.authored === true}, '2026-05-01T00:00:00Z'::timestamp, ${climb.seq})
      `);
      await db.execute(sql`
        INSERT INTO board_climb_stats
          (board_type, climb_uuid, angle, display_difficulty, ascensionist_count, quality_average,
           fa_username, fa_at, updated_at, sync_seq)
        VALUES
          (${BOARD_TYPE}, ${climb.uuid}, 40, 21.5, 12, 4.5, ${'Stored FA ' + climb.uuid},
           '2020-01-02T03:04:05Z'::timestamp, '2026-05-02T00:00:00.25Z'::timestamp, ${climb.seq})
      `);
      await db.execute(sql`
        INSERT INTO board_climb_grades
          (board_type, climb_uuid, angle, local_grade, universal_grade, grade_low, grade_high, confidence,
           ascensionist_count, model_version, coeff_version, computed_at, sync_seq)
        VALUES
          (${BOARD_TYPE}, ${climb.uuid}, 40, 20.5, 21.25, 19, 23, 'confirmed', 12, 'compat-model', 'compat-coeff',
           '2026-05-03T00:00:00Z'::timestamp, ${climb.seq})
      `);
    }
    await db.insert(schema.contentPrivacy).values({
      entityType: 'climb',
      entityId: 'compat-sync-orphan-policy',
      ownerId: null,
      audience: 'only_me',
    });
  });

  const ownerClimbs = deliveredTo(ownerId);
  const lastOwnerSeq = String(ownerClimbs.at(-1)?.seq);

  const expectedClimbsPage = {
    documents: ownerClimbs.map((climb) => ({
      uuid: climb.uuid,
      board_type: BOARD_TYPE,
      layout_id: LAYOUT_ID,
      setter_id: null,
      setter_username: null,
      name: climb.uuid,
      description: '',
      hsm: null,
      edge_left: null,
      edge_right: null,
      edge_bottom: null,
      edge_top: null,
      angle: null,
      frames_count: 1,
      frames_pace: 0,
      frames: null,
      // The flags travel with the row, so a device can tell its own draft from
      // a published climb.
      is_draft: climb.isDraft === true,
      is_listed: !climb.unlisted,
      is_hidden: false,
      created_at: null,
      published_at: null,
      user_id: climb.userId,
      required_set_ids: null,
      compatible_size_ids: [5],
      characteristics: null,
      hold_fingerprint: null,
      missing_hold_count: null,
      retired_by_reset: null,
      revision_number: 1,
      holds_revision_number: 1,
      updated_at: '2026-05-01T00:00:00Z',
      sync_seq: String(climb.seq),
    })),
    cursor: { updatedAt: '2026-05-01T00:00:00Z', syncSeq: lastOwnerSeq },
    hasMore: false,
  };

  // The first-ascent pair is the one value that changed inside a document. It
  // used to be the stored date plus a name looked up for this caller; it is now
  // the stored credit of a climb that never had a Boardsesh author and NULL for
  // every other climb, the same for every caller.
  const hasStoredCredit = (climb: CompatClimb) => climb.userId === null && !climb.authored;

  const expectedStatsPage = {
    documents: ownerClimbs.map((climb) => ({
      board_type: BOARD_TYPE,
      climb_uuid: climb.uuid,
      angle: 40,
      display_difficulty: 21.5,
      benchmark_difficulty: null,
      ascensionist_count: '12',
      difficulty_average: null,
      quality_average: 4.5,
      fa_username: hasStoredCredit(climb) ? `Stored FA ${climb.uuid}` : null,
      fa_at: hasStoredCredit(climb) ? '2020-01-02T03:04:05Z' : null,
      updated_at: '2026-05-02T00:00:00.25Z',
      sync_seq: String(climb.seq),
    })),
    cursor: { updatedAt: '2026-05-02T00:00:00.25Z', syncSeq: lastOwnerSeq },
    hasMore: false,
  };

  const expectedGradesPage = {
    documents: ownerClimbs.map((climb) => ({
      board_type: BOARD_TYPE,
      climb_uuid: climb.uuid,
      angle: 40,
      local_grade: 20.5,
      universal_grade: 21.25,
      grade_low: 19,
      grade_high: 23,
      confidence: 'confirmed',
      ascensionist_count: '12',
      computed_at: '2026-05-03T00:00:00Z',
      sync_seq: String(climb.seq),
    })),
    cursor: { updatedAt: '2026-05-03T00:00:00Z', syncSeq: lastOwnerSeq },
    hasMore: false,
  };

  it('states the change per climb: nothing unchanged or regained is missing, nothing lost is delivered', () => {
    const delivered = new Set(ownerClimbs.map((climb) => climb.uuid));
    expect(climbs.filter((climb) => climb.forOwner === 'lost').map((climb) => climb.uuid)).toEqual([
      'compat-sync-other-draft',
      'compat-sync-other-unlisted',
      'compat-sync-ownerless-draft',
      'compat-sync-ownerless-unlisted',
    ]);
    expect(climbs.filter((climb) => climb.forOwner === 'regained').map((climb) => climb.uuid)).toEqual([
      'compat-sync-private',
      'compat-sync-orphan-policy',
    ]);
    for (const climb of climbs) {
      expect(delivered.has(climb.uuid), climb.uuid).toBe(climb.forOwner !== 'lost');
    }
  });

  it('returns the published climbs and the caller’s own drafts and unlisted climbs from board_climbs', async () => {
    const page = await syncQueries.syncClimbs(undefined, scope, context);
    expect(JSON.stringify(page)).toBe(JSON.stringify(expectedClimbsPage));
  });

  it('returns the board_climb_stats rows of exactly those climbs', async () => {
    const page = await syncQueries.syncClimbStats(undefined, scope, context);
    expect(JSON.stringify(page)).toBe(JSON.stringify(expectedStatsPage));
  });

  it('returns the board_climb_grades rows of exactly those climbs', async () => {
    const page = await syncQueries.syncClimbGrades(undefined, scope, context);
    expect(JSON.stringify(page)).toBe(JSON.stringify(expectedGradesPage));
  });

  it('treats an explicit null audience exactly like an absent one', async () => {
    const nullAudience = { ...scope, audience: null };
    expect(JSON.stringify(await syncQueries.syncClimbs(undefined, nullAudience, context))).toBe(
      JSON.stringify(expectedClimbsPage),
    );
    expect(JSON.stringify(await syncQueries.syncClimbStats(undefined, nullAudience, context))).toBe(
      JSON.stringify(expectedStatsPage),
    );
    expect(JSON.stringify(await syncQueries.syncClimbGrades(undefined, nullAudience, context))).toBe(
      JSON.stringify(expectedGradesPage),
    );
  });

  type SyncPage = Awaited<ReturnType<typeof syncQueries.syncClimbs>>;
  const climbsOf = (page: SyncPage, key: 'uuid' | 'climb_uuid') =>
    (page.documents as Array<Record<string, unknown>>).map((document) => String(document[key]));
  const asViewer = (userId: string) => ({ ...context, userId }) as ConnectionContext;

  it.each([ownerId, collaboratorId, privateOwnerId])(
    'gives %s every published climb plus only their own drafts and unlisted climbs, in all three tables',
    async (viewerId) => {
      const expected = deliveredTo(viewerId).map((climb) => climb.uuid);
      const viewerContext = asViewer(viewerId);
      const climbsPage = await syncQueries.syncClimbs(undefined, scope, viewerContext);
      expect(climbsOf(climbsPage, 'uuid')).toEqual(expected);
      expect(climbsOf(await syncQueries.syncClimbStats(undefined, scope, viewerContext), 'climb_uuid')).toEqual(
        expected,
      );
      expect(climbsOf(await syncQueries.syncClimbGrades(undefined, scope, viewerContext), 'climb_uuid')).toEqual(
        expected,
      );

      // Every non-public row a caller receives is their own.
      for (const document of climbsPage.documents as Array<Record<string, unknown>>) {
        if (document.is_draft === true || document.is_listed !== true) expect(document.user_id).toBe(viewerId);
      }
    },
  );

  it('ends on the last row the caller may see: a withheld row never becomes a cursor position', async () => {
    // The four rows at the tail of the cursor order are withheld from this
    // caller, who owns none of them.
    const page = await syncQueries.syncClimbs(undefined, scope, asViewer(privateOwnerId));
    expect(climbsOf(page, 'uuid').at(-1)).toBe('compat-sync-orphan-policy');
    expect(page.hasMore).toBe(false);
    expect(page.cursor).toEqual({ updatedAt: '2026-05-01T00:00:00Z', syncSeq: '910005' });
  });

  // The document every shipped binary sends, as `buildSyncQuery` in
  // `@boardsesh/offline-sync` wrote it before the split: no `$audience`
  // variable and no `audience` argument. Kept as a literal here because that
  // builder will change with the client half, and the fleet's copy will not.
  function shippedDocument(queryName: 'syncClimbs' | 'syncClimbStats' | 'syncClimbGrades'): string {
    return `
      query ${queryName[0].toUpperCase()}${queryName.slice(1)}($boardType: String!, $layoutId: Int, $sizeId: Int, $cursor: SyncCursorInput, $limit: Int! = 500) {
        ${queryName}(boardType: $boardType, layoutId: $layoutId, sizeId: $sizeId, cursor: $cursor, limit: $limit) {
          documents
          cursor {
            updatedAt
            syncSeq
          }
          hasMore
        }
      }
    `;
  }

  const graphSchema = buildSchema(typeDefs.join('\n'));
  type SyncArgs = Parameters<typeof syncQueries.syncClimbs>[1];
  const rootValue = {
    syncClimbs: (args: SyncArgs) => syncQueries.syncClimbs(undefined, args, context),
    syncClimbStats: (args: SyncArgs) => syncQueries.syncClimbStats(undefined, args, context),
    syncClimbGrades: (args: SyncArgs) => syncQueries.syncClimbGrades(undefined, args, context),
  };

  it.each([
    ['syncClimbs', expectedClimbsPage],
    ['syncClimbStats', expectedStatsPage],
    ['syncClimbGrades', expectedGradesPage],
  ] as const)('still executes the shipped %s document and returns that page', async (queryName, expectedPage) => {
    const response = await graphql({
      schema: graphSchema,
      source: shippedDocument(queryName),
      variableValues: { boardType: BOARD_TYPE, layoutId: LAYOUT_ID, sizeId: null, cursor: null },
      rootValue,
    });
    expect(response.errors).toBeUndefined();
    expect(JSON.stringify(response.data?.[queryName])).toBe(JSON.stringify(expectedPage));
  });

  it('accepts the audience argument through the schema and rejects a value the enum lacks', async () => {
    const source = `
      query SyncClimbs($boardType: String!, $layoutId: Int, $audience: SyncAudience) {
        syncClimbs(boardType: $boardType, layoutId: $layoutId, audience: $audience) { documents hasMore }
      }
    `;
    const variableValues = { boardType: BOARD_TYPE, layoutId: LAYOUT_ID };
    const uuidsOf = (data: unknown) =>
      ((data as { syncClimbs: { documents: Array<{ uuid: string }> } }).syncClimbs.documents ?? []).map(
        (document) => document.uuid,
      );

    const reference = await graphql({
      schema: graphSchema,
      source,
      variableValues: { ...variableValues, audience: 'REFERENCE' },
      rootValue,
    });
    expect(reference.errors).toBeUndefined();
    expect(uuidsOf(reference.data)).toEqual(climbs.filter(isPublic).map((climb) => climb.uuid));

    const protectedStream = await graphql({
      schema: graphSchema,
      source,
      variableValues: { ...variableValues, audience: 'PROTECTED' },
      rootValue,
    });
    expect(protectedStream.errors).toBeUndefined();
    expect(uuidsOf(protectedStream.data)).toEqual(['compat-sync-own-draft', 'compat-sync-own-unlisted']);

    const unknownAudience = await graphql({
      schema: graphSchema,
      source,
      variableValues: { ...variableValues, audience: 'EVERYONE' },
      rootValue,
    });
    expect(unknownAudience.data).toBeUndefined();
    expect(unknownAudience.errors?.[0]?.message).toMatch(/SyncAudience/);
  });
});
