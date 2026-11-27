import { afterEach, beforeAll, describe, expect, it } from 'vite-plus/test';
import { and, eq, ne } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import * as schema from '@boardsesh/db/schema';
import { db } from '../db/client';
import { climbMutations } from '../graphql/resolvers/climbs/mutations';
import { boardPresenceMutations } from '../graphql/resolvers/board-presence/mutations';
import { boardPresenceQueries } from '../graphql/resolvers/board-presence/queries';
import { syncQueries } from '../graphql/resolvers/sync/queries';
import { pubsub } from '../pubsub';
import { roomManager } from '../services/room-manager';
import { quantumCanonicalClimbUuid } from '../services/quantum-catalog-mapping';
import { importFixture, quantumCatalogFixture } from '../services/__tests__/quantum-catalog-fixture';

const OWNER = 'quantum-safety-owner';
const VIEWER = 'quantum-safety-viewer';
const context = (userId: string): ConnectionContext => ({
  connectionId: `quantum-safety-${userId}`,
  isAuthenticated: true,
  userId,
});

beforeAll(async () => {
  await db
    .insert(schema.users)
    .values([
      { id: OWNER, name: 'Quantum setter', email: 'quantum-safety-owner@example.com' },
      { id: VIEWER, name: 'Quantum viewer', email: 'quantum-safety-viewer@example.com' },
    ])
    .onConflictDoNothing();
  await importFixture(quantumCatalogFixture());
  // Other models enclose the authored holds, but use different physical diodes.
  await db
    .update(schema.boardProductSizes)
    .set({ edgeLeft: -10000, edgeRight: 10000, edgeBottom: -10000, edgeTop: 10000 })
    .where(and(eq(schema.boardProductSizes.boardType, 'quantum'), ne(schema.boardProductSizes.id, 9201)));
});

afterEach(async () => {
  await roomManager.removeClient(context(OWNER).connectionId);
  await roomManager.removeClient(context(VIEWER).connectionId);
});

describe('Quantum authored-climb safety', () => {
  it('enables the common layer-presence contract only on boards advertising simultaneous climbs', async () => {
    const [board] = await db
      .insert(schema.userBoards)
      .values({
        uuid: '99999999-9999-4999-8999-999999999999',
        slug: 'single-climb-safety-wall',
        ownerId: OWNER,
        boardType: 'kilter',
        layoutId: 1,
        sizeId: 1,
        setIds: '1',
        name: 'Single climb wall',
        isPublic: true,
      })
      .returning();
    expect(await boardPresenceQueries.boardLayers({}, { boardId: board.id }, context(OWNER))).toBeNull();
    await expect(
      boardPresenceMutations.reportBoardLayers({}, { boardId: board.id, layers: [] }, context(OWNER)),
    ).rejects.toThrow(/does not support simultaneous climbs/);
  });

  it('saves and edits as fully synced on exactly one model, including boundary holds', async () => {
    const saved = await climbMutations.saveClimb(
      {},
      {
        input: {
          boardType: 'quantum',
          layoutId: 9101,
          name: 'Quantum edge test',
          isDraft: true,
          frames: 'p1000007r12p1000009r14',
          angle: 40,
        },
      },
      context(OWNER),
    );
    expect(saved.synced).toBe(true);
    const [created] = await db.select().from(schema.boardClimbs).where(eq(schema.boardClimbs.uuid, saved.uuid));
    expect(created).toMatchObject({ synced: true, compatibleSizeIds: [9201], requiredSetIds: [1] });
    expect(created.holdFingerprint).toBeTruthy();

    await climbMutations.updateClimb(
      {},
      {
        input: {
          uuid: saved.uuid,
          boardType: 'quantum',
          frames: 'p1000008r12p1000010r14',
        },
      },
      context(OWNER),
    );
    const [edited] = await db.select().from(schema.boardClimbs).where(eq(schema.boardClimbs.uuid, saved.uuid));
    expect(edited).toMatchObject({ synced: true, compatibleSizeIds: [9201], requiredSetIds: [1] });
    expect(edited.holdFingerprint).toBeTruthy();
    expect(edited.holdFingerprint).not.toBe(created.holdFingerprint);
  });

  it('rejects XL-only holds when saving or editing a climb on the shared-layout M board', async () => {
    const input = {
      boardType: 'quantum',
      layoutId: 9101,
      name: 'Quantum scope validation',
      isDraft: true,
      frames: 'p1000007r12p1000009r14',
      angle: 40,
    };
    await expect(
      climbMutations.saveClimb({}, { input: { ...input, sizeId: 9203 } }, context(OWNER)),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    const saved = await climbMutations.saveClimb({}, { input: { ...input, sizeId: 9201 } }, context(OWNER));
    await expect(
      climbMutations.updateClimb(
        {},
        {
          input: { uuid: saved.uuid, boardType: 'quantum', sizeId: 9203, frames: 'p1000008r12p1000010r14' },
        },
        context(OWNER),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(await db.select().from(schema.boardClimbs).where(eq(schema.boardClimbs.uuid, saved.uuid))).toMatchObject([
      { frames: input.frames, isDraft: true },
    ]);
  });

  it('keeps a lit personal draft unidentified for its owner and unrelated viewers', async () => {
    const draftUuid = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    await db.insert(schema.boardClimbs).values({
      uuid: draftUuid,
      boardType: 'quantum',
      layoutId: 9101,
      userId: OWNER,
      name: 'Personal draft',
      isDraft: true,
      isListed: false,
      frames: 'p1000007r12p1000009r14',
      controllerRouteUuid: '44444444-4444-4444-8444-444444444444',
    });
    const [board] = await db
      .insert(schema.userBoards)
      .values({
        uuid: '55555555-5555-4555-8555-555555555555',
        slug: 'quantum-safety-wall',
        ownerId: OWNER,
        boardType: 'quantum',
        layoutId: 9101,
        sizeId: 9201,
        setIds: '1',
        name: 'Quantum safety wall',
        isPublic: true,
      })
      .returning();
    for (const reporter of [OWNER, VIEWER]) {
      const reporterContext = context(reporter);
      await roomManager.registerClient(reporterContext.connectionId, 'Quantum climber', reporter);
      await pubsub.stampBoardMembership(String(board.id), reporter);
      const snapshot = await boardPresenceMutations.reportBoardLayers(
        {},
        {
          boardId: board.id,
          layers: [
            {
              color: '#00FF00',
              remainingSeconds: 120,
              climbUuid: draftUuid,
              angle: 40,
              geometryKnown: true,
            },
          ],
        },
        reporterContext,
      );
      expect(snapshot.layers).toEqual([
        {
          color: '#00FF00',
          remainingSeconds: 120,
          climbUuid: null,
          angle: null,
          geometryKnown: false,
          placementIds: [],
        },
      ]);
      const viewed = await boardPresenceQueries.boardLayers({}, { boardId: board.id }, context(VIEWER));
      expect(viewed?.layers).toMatchObject([{ climbUuid: null, geometryKnown: false, placementIds: [] }]);
    }

    const publicSnapshot = await boardPresenceMutations.reportBoardLayers(
      {},
      {
        boardId: board.id,
        layers: [
          {
            color: '#00FF00',
            remainingSeconds: 120,
            climbUuid: quantumCanonicalClimbUuid(9101, '11111111-1111-4111-8111-111111111111'),
            angle: 40,
            geometryKnown: true,
          },
        ],
      },
      context(OWNER),
    );
    expect(publicSnapshot.layers).toMatchObject([
      {
        climbUuid: quantumCanonicalClimbUuid(9101, '11111111-1111-4111-8111-111111111111'),
        geometryKnown: true,
        placementIds: [1000007, 1000008, 1000009, 1000010],
      },
    ]);
  });

  it('keeps an XL-only source route geometrically unknown on a shared-layout M wall', async () => {
    const climbUuid = quantumCanonicalClimbUuid(9101, '11111111-1111-4111-8111-111111111111');
    const [sourceClimb] = await db.select().from(schema.boardClimbs).where(eq(schema.boardClimbs.uuid, climbUuid));
    expect(sourceClimb.compatibleSizeIds).toEqual([9201]);
    const [board] = await db
      .insert(schema.userBoards)
      .values({
        uuid: '88888888-8888-4888-8888-888888888888',
        slug: 'quantum-m-size-safety-wall',
        ownerId: OWNER,
        boardType: 'quantum',
        layoutId: 9101,
        sizeId: 9203,
        setIds: '1',
        name: 'Quantum M wall',
        isPublic: true,
      })
      .returning();
    await roomManager.registerClient(context(OWNER).connectionId, 'Quantum climber', OWNER);
    await pubsub.stampBoardMembership(String(board.id), OWNER);
    const snapshot = await boardPresenceMutations.reportBoardLayers(
      {},
      {
        boardId: board.id,
        layers: [{ color: '#00FF00', remainingSeconds: 120, climbUuid, angle: 40, geometryKnown: true }],
      },
      context(OWNER),
    );
    expect(snapshot.layers).toMatchObject([{ climbUuid, geometryKnown: false, placementIds: [] }]);
    expect((await boardPresenceQueries.boardLayers({}, { boardId: board.id }, context(VIEWER)))?.layers).toMatchObject([
      { climbUuid, geometryKnown: false, placementIds: [] },
    ]);
  });

  it('never replaces physically lit app holds with a later edit reported by another phone', async () => {
    const climbUuid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const controllerRouteUuid = '66666666-6666-4666-8666-666666666666';
    await db.insert(schema.boardClimbs).values({
      uuid: climbUuid,
      boardType: 'quantum',
      layoutId: 9101,
      userId: OWNER,
      controllerRouteUuid,
      isDraft: false,
      isListed: true,
      name: 'Mutable public route',
      publishedAt: new Date().toISOString(),
      frames: 'p1000007r12p1000009r14',
      framesCount: 1,
      angle: 40,
    });
    const [board] = await db
      .insert(schema.userBoards)
      .values({
        uuid: '77777777-7777-4777-8777-777777777777',
        slug: 'quantum-mutable-wall',
        ownerId: OWNER,
        boardType: 'quantum',
        layoutId: 9101,
        sizeId: 9201,
        setIds: '1',
        name: 'Mutable route wall',
        isPublic: true,
      })
      .returning();
    for (const reporter of [OWNER, VIEWER]) {
      await roomManager.registerClient(context(reporter).connectionId, 'Quantum climber', reporter);
      await pubsub.stampBoardMembership(String(board.id), reporter);
    }
    const reportLitRoute = (reporter: string) =>
      boardPresenceMutations.reportBoardLayers(
        {},
        {
          boardId: board.id,
          layers: [{ color: '#00FF00', remainingSeconds: 120, climbUuid, angle: 40, geometryKnown: true }],
        },
        context(reporter),
      );
    expect((await reportLitRoute(OWNER)).layers).toMatchObject([{ climbUuid, geometryKnown: false, placementIds: [] }]);

    // A second phone changes the persisted route while the first phone's LEDs
    // still show the original holds under the same stable controller UUID.
    await climbMutations.updateClimb(
      {},
      {
        input: {
          uuid: climbUuid,
          boardType: 'quantum',
          frames: 'p1000008r12p1000010r14',
        },
      },
      { ...context(OWNER), connectionId: 'quantum-second-owner-phone' },
    );
    const [edited] = await db.select().from(schema.boardClimbs).where(eq(schema.boardClimbs.uuid, climbUuid));
    expect(edited).toMatchObject({ controllerRouteUuid, frames: 'p1000008r12p1000010r14' });
    expect((await reportLitRoute(OWNER)).layers).toMatchObject([{ climbUuid, geometryKnown: false, placementIds: [] }]);
    expect((await reportLitRoute(VIEWER)).layers).toMatchObject([
      { climbUuid, geometryKnown: false, placementIds: [] },
    ]);
    expect((await boardPresenceQueries.boardLayers({}, { boardId: board.id }, context(VIEWER)))?.layers).toMatchObject([
      { climbUuid, geometryKnown: false, placementIds: [] },
    ]);

    // Retained app climbs stay mutable app provenance after account deletion.
    await db
      .update(schema.boardClimbs)
      .set({ userId: null, isBoardseshAuthored: true })
      .where(eq(schema.boardClimbs.uuid, climbUuid));
    expect((await reportLitRoute(VIEWER)).layers).toMatchObject([
      { climbUuid, geometryKnown: false, placementIds: [] },
    ]);
    const syncPage = await syncQueries.syncClimbs(
      {},
      {
        boardType: 'quantum',
        layoutId: 9101,
        cursor: null,
        limit: 500,
      },
      context(VIEWER),
    );
    expect(syncPage.documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ uuid: climbUuid, user_id: null, is_boardsesh_authored: true }),
        expect.objectContaining({
          uuid: quantumCanonicalClimbUuid(9101, '11111111-1111-4111-8111-111111111111'),
          user_id: null,
          is_boardsesh_authored: false,
        }),
      ]),
    );
  });
});
