import { randomInt, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import * as tables from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import * as runtimeLoader from '../../../auth/partner/load-authority';
import type { PartnerAuthorityRuntime } from '../../../auth/partner/authority';
import { executeGymMcpTool } from '../dispatch';
import { GYM_MCP_RESOURCE } from '../configuration';
import type { GymMcpPrincipal } from '../auth';
import {
  inspectSprayWallGymLinks,
  attachUnlinkedSprayWallToGym,
  authorizeSprayWallGymLinkReplay,
} from '../admin-spray-wall-links';

const OPERATION = 'attach_unlinked_spray_wall_to_gym';
let adminId: string;
let ownerId: string;
let scopedAdminId: string;
let gym: typeof tables.gyms.$inferSelect;
let otherGym: typeof tables.gyms.$inferSelect;

function context(userId = adminId): ConnectionContext {
  return { connectionId: `gym-mcp-${randomUUID()}`, transport: 'http', userId, isAuthenticated: true };
}

beforeEach(async () => {
  adminId = randomUUID();
  ownerId = randomUUID();
  scopedAdminId = randomUUID();
  await db.insert(tables.users).values([
    { id: adminId, email: `${adminId}@example.test`, name: 'Global admin' },
    { id: ownerId, email: `${ownerId}@example.test`, name: 'Wall creator' },
    { id: scopedAdminId, email: `${scopedAdminId}@example.test`, name: 'Scoped admin' },
  ]);
  await db.insert(tables.communityRoles).values([
    { userId: adminId, role: 'admin', boardType: null },
    { userId: scopedAdminId, role: 'admin', boardType: 'spray' },
  ]);
  [gym, otherGym] = await db
    .insert(tables.gyms)
    .values([
      { uuid: randomUUID(), slug: `destination-${randomUUID()}`, name: 'Selected gym', ownerId },
      { uuid: randomUUID(), slug: `other-${randomUUID()}`, name: 'Other gym', ownerId },
    ])
    .returning();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function createWall(isPublic = false) {
  const layoutId = randomInt(1_000_000, 2_000_000_000);
  const [board] = await db
    .insert(tables.userBoards)
    .values({
      uuid: randomUUID(),
      slug: `spray-link-${randomUUID()}`,
      ownerId,
      boardType: 'spray',
      layoutId,
      sizeId: layoutId,
      setIds: '1',
      name: 'Explicitly selected wall',
      angle: 30,
      isAngleAdjustable: false,
      isPublic,
      isUnlisted: false,
      hideLocation: true,
      hasLeds: false,
      serialNumber: 'private-pairing-marker',
      latitude: null,
      longitude: null,
    })
    .returning();
  await db.insert(tables.resourcePrivacy).values({
    kind: 'board',
    resourceId: board.uuid,
    ownerId,
    audience: isPublic ? 'public' : 'only_me',
    locationAudience: 'only_me',
    revision: 2,
  });
  const [wall] = await db
    .insert(tables.sprayWalls)
    .values({
      boardUuid: board.uuid,
      layoutId,
      holdCount: 1,
      referenceWidth: 1000,
      referenceHeight: 1000,
      publicPhotoKey: isPublic ? 'private-public-photo-key-marker' : null,
      pendingIsPublic: isPublic ? null : true,
      pendingIsUnlisted: isPublic ? null : false,
    })
    .returning();
  const [version] = await db
    .insert(tables.sprayWallVersions)
    .values({
      wallId: wall.id,
      versionNumber: 1,
      status: isPublic ? 'published' : 'draft',
      photoKey: 'private-original-photo-key-marker',
      photoWidth: 1000,
      photoHeight: 1000,
      createdBy: ownerId,
    })
    .returning();
  if (isPublic)
    await db.update(tables.sprayWalls).set({ currentVersionId: version.id }).where(eq(tables.sprayWalls.id, wall.id));
  await db.insert(tables.sprayWallHolds).values({
    wallId: wall.id,
    holdId: 1,
    cx: 100,
    cy: 200,
    r: 25,
    installedVersionId: version.id,
  });
  const climbUuid = randomUUID();
  await db.insert(tables.boardClimbs).values({
    uuid: climbUuid,
    boardType: 'spray',
    layoutId,
    name: 'Existing climb',
    userId: ownerId,
    frames: 'p1r1',
  });
  await db.insert(tables.boardClimbEvents).values({
    boardId: board.id,
    boardType: 'spray',
    climbUuid,
    userId: ownerId,
    seq: 1,
    confirmedAt: new Date().toISOString(),
    name: 'private-activity-marker',
  });
  await db.insert(tables.boardseshTicks).values({
    uuid: randomUUID(),
    userId: ownerId,
    boardId: board.id,
    boardType: 'spray',
    climbUuid,
    angle: 30,
    status: 'send',
    climbedAt: new Date().toISOString(),
  });
  return { board, wall, version, climbUuid };
}

async function snapshot(fixture: Awaited<ReturnType<typeof createWall>>) {
  const [boards, policies, walls, versions, holds, climbs, events, ticks] = await Promise.all([
    db.select().from(tables.userBoards).where(eq(tables.userBoards.id, fixture.board.id)),
    db.select().from(tables.resourcePrivacy).where(eq(tables.resourcePrivacy.resourceId, fixture.board.uuid)),
    db.select().from(tables.sprayWalls).where(eq(tables.sprayWalls.id, fixture.wall.id)),
    db.select().from(tables.sprayWallVersions).where(eq(tables.sprayWallVersions.wallId, fixture.wall.id)),
    db.select().from(tables.sprayWallHolds).where(eq(tables.sprayWallHolds.wallId, fixture.wall.id)),
    db.select().from(tables.boardClimbs).where(eq(tables.boardClimbs.uuid, fixture.climbUuid)),
    db.select().from(tables.boardClimbEvents).where(eq(tables.boardClimbEvents.boardId, fixture.board.id)),
    db.select().from(tables.boardseshTicks).where(eq(tables.boardseshTicks.boardId, fixture.board.id)),
  ]);
  return { board: boards[0]!, policies, walls, versions, holds, climbs, events, ticks };
}

async function attachmentInput(boardUuid: string) {
  const inspected = await inspectSprayWallGymLinks({ gymUuid: gym.uuid, boardUuids: [boardUuid] }, context());
  return {
    gymUuid: gym.uuid,
    boardUuid,
    expectedStateHash: inspected.boards[0]!.stateHash,
    expectedGymStateHash: inspected.gym.stateHash,
    reason: 'The creator confirmed this wall belongs to the selected gym.',
  };
}

async function audits() {
  return db
    .select()
    .from(tables.gymDirectoryRepairAudit)
    .where(
      and(
        eq(tables.gymDirectoryRepairAudit.operation, OPERATION),
        eq(tables.gymDirectoryRepairAudit.gymUuid, gym.uuid),
      ),
    );
}

async function principal(): Promise<GymMcpPrincipal> {
  const identity: GymMcpPrincipal = {
    userId: adminId,
    clientId: `https://assistant.example/${randomUUID()}`,
    connectionId: randomUUID(),
    connectionGeneration: 1,
    scopes: ['gyms:admin:read', 'gyms:admin:write'],
    accessTokenHash: randomUUID(),
    connectionLastUsedAt: null,
  };
  await db
    .insert(tables.oauthClient)
    .values({ id: randomUUID(), clientId: identity.clientId, redirectUris: ['https://assistant.example/callback'] });
  await db.insert(tables.oauthConnections).values({
    id: identity.connectionId,
    userId: adminId,
    clientId: identity.clientId,
    generation: 1,
    scopes: identity.scopes,
  });
  const authorizationCodeId = randomUUID();
  await db
    .insert(tables.oauthGrants)
    .values({ authorizationCodeId, connectionId: identity.connectionId, generation: 1 });
  await db.insert(tables.oauthAccessToken).values({
    id: randomUUID(),
    token: identity.accessTokenHash,
    userId: adminId,
    clientId: identity.clientId,
    authorizationCodeId,
    resources: [GYM_MCP_RESOURCE],
    scopes: identity.scopes,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
  });
  vi.stubEnv('PARTNER_OAUTH_MODE', 'open');
  vi.stubEnv('GYM_MCP_MODE', 'on');
  vi.spyOn(runtimeLoader, 'loadPartnerAuthority').mockResolvedValue({
    configuration: { gymMcp: { mode: 'on', pilotUserIds: [] } },
    gymMcpApi: {},
  } as unknown as PartnerAuthorityRuntime);
  return identity;
}

describe('explicit admin spray wall gym links', () => {
  it.each([false, true])(
    'links a private draft or public wall (isPublic=%s), preserving all other state',
    async (isPublic) => {
      const fixture = await createWall(isPublic);
      const before = await snapshot(fixture);
      const input = await attachmentInput(fixture.board.uuid);
      const inspected = await inspectSprayWallGymLinks(
        { gymUuid: gym.uuid, boardUuids: [fixture.board.uuid] },
        context(),
      );
      expect(inspected.boards[0]).toMatchObject({
        ownerId,
        ownerDisplayName: 'Wall creator',
        isPublic,
        isPublished: isPublic,
        isLinked: false,
      });
      const encoded = JSON.stringify(inspected);
      expect(encoded).not.toMatch(/private-|latitude|longitude|photo|serial|activity|climbEvents|ticks/);
      expect(await attachUnlinkedSprayWallToGym(input, context())).toMatchObject({
        gymUuid: gym.uuid,
        boardUuid: fixture.board.uuid,
      });
      const after = await snapshot(fixture);
      expect(after.board.gymId).toBe(gym.id);
      expect(after.board.syncFrozenAt).toBeInstanceOf(Date);
      expect({
        ...after.board,
        gymId: before.board.gymId,
        updatedAt: before.board.updatedAt,
        syncFrozenAt: before.board.syncFrozenAt,
      }).toEqual(before.board);
      expect({ ...after, board: before.board }).toEqual(before);
      const audit = await audits();
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        actorUserId: adminId,
        reason: input.reason,
        before: { gymId: null },
        after: { gymId: gym.id },
      });
      expect(await db.select().from(tables.gymMembers).where(eq(tables.gymMembers.gymId, gym.id))).toEqual([]);
      expect(
        await db
          .select()
          .from(tables.boardModerationEvents)
          .where(eq(tables.boardModerationEvents.boardId, fixture.board.id)),
      ).toMatchObject([{ action: 'relinked', actorRole: 'global_admin', gymId: gym.id }]);
    },
  );

  it('requires explicit bounded distinct UUIDs and a live destination', async () => {
    const fixture = await createWall();
    await expect(inspectSprayWallGymLinks({ gymUuid: gym.uuid, boardUuids: [] }, context())).rejects.toThrow();
    await expect(
      inspectSprayWallGymLinks(
        { gymUuid: gym.uuid, boardUuids: Array.from({ length: 11 }, () => randomUUID()) },
        context(),
      ),
    ).rejects.toThrow();
    await expect(
      inspectSprayWallGymLinks({ gymUuid: gym.uuid, boardUuids: [fixture.board.uuid, fixture.board.uuid] }, context()),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    await expect(
      inspectSprayWallGymLinks({ gymUuid: randomUUID(), boardUuids: [fixture.board.uuid] }, context()),
    ).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
  });

  it('denies owners, scoped admins, anonymous callers and revoked global admins', async () => {
    const fixture = await createWall();
    const input = await attachmentInput(fixture.board.uuid);
    for (const userId of [ownerId, scopedAdminId]) {
      await expect(
        inspectSprayWallGymLinks({ gymUuid: gym.uuid, boardUuids: [fixture.board.uuid] }, context(userId)),
      ).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
      await expect(attachUnlinkedSprayWallToGym(input, context(userId))).rejects.toMatchObject({
        extensions: { code: 'FORBIDDEN' },
      });
    }
    await expect(
      inspectSprayWallGymLinks(
        { gymUuid: gym.uuid, boardUuids: [fixture.board.uuid] },
        { ...context(), isAuthenticated: false },
      ),
    ).rejects.toThrow();
    await db.delete(tables.communityRoles).where(eq(tables.communityRoles.userId, adminId));
    await expect(attachUnlinkedSprayWallToGym(input, context())).rejects.toMatchObject({
      extensions: { code: 'FORBIDDEN' },
    });
    expect(await audits()).toEqual([]);
  });

  it.each(['board', 'privacy', 'gym'])('refuses a stale %s hash without attaching or auditing', async (changed) => {
    const fixture = await createWall();
    const input = await attachmentInput(fixture.board.uuid);
    if (changed === 'board')
      await db.update(tables.userBoards).set({ angle: 40 }).where(eq(tables.userBoards.id, fixture.board.id));
    if (changed === 'privacy')
      await db
        .update(tables.resourcePrivacy)
        .set({ audience: 'followers', revision: 3 })
        .where(eq(tables.resourcePrivacy.resourceId, fixture.board.uuid));
    if (changed === 'gym')
      await db.update(tables.gyms).set({ name: 'Changed destination' }).where(eq(tables.gyms.id, gym.id));
    await expect(attachUnlinkedSprayWallToGym(input, context())).rejects.toMatchObject({
      extensions: { code: 'CONFLICT' },
    });
    expect((await snapshot(fixture)).board.gymId).toBeNull();
    expect(await audits()).toEqual([]);
  });

  it.each([
    'linked here',
    'linked elsewhere',
    'catalogue board',
    'deleted board',
    'deleted wall',
    'archived wall',
    'deleted gym',
    'merged gym',
  ])('refuses %s', async (status) => {
    const fixture = await createWall();
    const input = await attachmentInput(fixture.board.uuid);
    if (status === 'linked here' || status === 'linked elsewhere')
      await db
        .update(tables.userBoards)
        .set({ gymId: status === 'linked here' ? gym.id : otherGym.id })
        .where(eq(tables.userBoards.id, fixture.board.id));
    if (status === 'catalogue board')
      await db.update(tables.userBoards).set({ boardType: 'kilter' }).where(eq(tables.userBoards.id, fixture.board.id));
    if (status === 'deleted board')
      await db
        .update(tables.userBoards)
        .set({ deletedAt: new Date() })
        .where(eq(tables.userBoards.id, fixture.board.id));
    if (status === 'deleted wall')
      await db
        .update(tables.sprayWalls)
        .set({ deletedAt: new Date() })
        .where(eq(tables.sprayWalls.id, fixture.wall.id));
    if (status === 'archived wall')
      await db
        .update(tables.sprayWalls)
        .set({ archivedAt: new Date() })
        .where(eq(tables.sprayWalls.id, fixture.wall.id));
    if (status === 'deleted gym')
      await db.update(tables.gyms).set({ deletedAt: new Date() }).where(eq(tables.gyms.id, gym.id));
    if (status === 'merged gym')
      await db.update(tables.gyms).set({ mergedIntoGymId: otherGym.id }).where(eq(tables.gyms.id, gym.id));
    await expect(attachUnlinkedSprayWallToGym(input, context())).rejects.toBeInstanceOf(GraphQLError);
    expect(await audits()).toEqual([]);
  });

  it('refuses a staff listing hold instead of lifting it', async () => {
    const fixture = await createWall();
    await db.insert(tables.boardModerationEvents).values({
      boardId: fixture.board.id,
      gymId: gym.id,
      actorUserId: adminId,
      actorRole: 'gym_admin',
      action: 'removed_from_gym',
    });
    const inspection = await inspectSprayWallGymLinks(
      { gymUuid: gym.uuid, boardUuids: [fixture.board.uuid] },
      context(),
    );
    expect(inspection.boards[0]!.isHeldOffGym).toBe(true);
    await expect(
      attachUnlinkedSprayWallToGym(await attachmentInput(fixture.board.uuid), context()),
    ).rejects.toMatchObject({ extensions: { code: 'CONFLICT' } });
    expect((await snapshot(fixture)).board.gymId).toBeNull();
  });

  it.each(['board', 'policy', 'wall'])('does not wait behind an inverse writer holding the %s', async (locked) => {
    const fixture = await createWall();
    const input = await attachmentInput(fixture.board.uuid);
    let ready!: () => void;
    let release!: () => void;
    const acquired = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = db.transaction(async (transaction) => {
      if (locked === 'board')
        await transaction
          .select()
          .from(tables.userBoards)
          .where(eq(tables.userBoards.id, fixture.board.id))
          .for('update');
      if (locked === 'policy')
        await transaction
          .select()
          .from(tables.resourcePrivacy)
          .where(eq(tables.resourcePrivacy.resourceId, fixture.board.uuid))
          .for('update');
      if (locked === 'wall')
        await transaction
          .select()
          .from(tables.sprayWalls)
          .where(eq(tables.sprayWalls.id, fixture.wall.id))
          .for('update');
      ready();
      await released;
    });
    try {
      await acquired;
      await expect(attachUnlinkedSprayWallToGym(input, context())).rejects.toMatchObject({
        extensions: { code: 'CONFLICT' },
      });
    } finally {
      release();
      await holder;
    }
    expect((await snapshot(fixture)).board.gymId).toBeNull();
  });

  it('commits and replays one real OAuth receipt, then rejects privacy and role drift', async () => {
    const fixture = await createWall();
    const input = { ...(await attachmentInput(fixture.board.uuid)), idempotencyKey: randomUUID(), confirm: true };
    const identity = await principal();
    const first = await executeGymMcpTool(identity, OPERATION, input);
    const firstState = await snapshot(fixture);
    expect(await executeGymMcpTool(identity, OPERATION, input)).toEqual(first);
    expect(await snapshot(fixture)).toEqual(firstState);
    expect(await audits()).toHaveLength(1);
    expect(
      await db
        .select()
        .from(tables.gymMcpWriteReceipts)
        .where(eq(tables.gymMcpWriteReceipts.idempotencyKey, input.idempotencyKey)),
    ).toHaveLength(1);
    await db
      .update(tables.resourcePrivacy)
      .set({ audience: 'followers', revision: 3 })
      .where(eq(tables.resourcePrivacy.resourceId, fixture.board.uuid));
    await expect(executeGymMcpTool(identity, OPERATION, input)).rejects.toMatchObject({
      extensions: { code: 'CONFLICT' },
    });
    await db.delete(tables.communityRoles).where(eq(tables.communityRoles.userId, adminId));
    await expect(authorizeSprayWallGymLinkReplay(input, context())).rejects.toMatchObject({
      extensions: { code: 'FORBIDDEN' },
    });
  });
});
