import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { and, eq } from 'drizzle-orm';
import { playlistVisibilityCondition } from '@boardsesh/db/queries';
import * as schema from '@boardsesh/db/schema';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { playlistMutations } from '../graphql/resolvers/playlists/mutations';
import { socialBoardMutations } from '../graphql/resolvers/social/boards';
import { sessionEditMutations } from '../graphql/resolvers/social/session-mutations';
import { sessionMutations } from '../graphql/resolvers/sessions/mutations';
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

  it.each(['0', '1'])(
    'protects restrictive account defaults on both old session creation paths with controls enabled=%s',
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

  it('allows the legacy switch to narrow a modern public session', async () => {
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
    expect(policy.audience).toBe('invite_only');
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
