import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import {
  communityRoles,
  gyms,
  sprayWallDetections,
  sprayWalls,
  sprayWallVersions,
  userBoards,
  users,
} from '@boardsesh/db/schema';
import { db } from '../db/client';
import { sprayWallMutations } from '../graphql/resolvers/board/spray-walls';
import { enrichSprayNotificationTargets } from '../graphql/resolvers/social/spray-notification-targets';
import { completionNotification } from '../services/spray-detection-notifications';

vi.mock('../utils/redis-rate-limiter', () => ({ checkRateLimitRedis: vi.fn().mockResolvedValue(undefined) }));

describe('spray notification version history', () => {
  it('refreshes revoked community access while retaining gym-owner targets in the same feed batch', async () => {
    const ownerId = randomUUID();
    const recipientId = randomUUID();
    await db
      .insert(users)
      .values(
        [ownerId, recipientId].map((id) => ({ id, name: 'Feed authorization tester', email: `${id}@example.test` })),
      );
    const [gym] = await db
      .insert(gyms)
      .values({ uuid: randomUUID(), name: 'Feed target gym', ownerId: recipientId })
      .returning();
    await db.insert(communityRoles).values({ userId: recipientId, role: 'community_leader', boardType: 'spray' });
    const sources: Array<{ detectionId: string; wallUuid: string }> = [];
    for (const accessKind of ['community', 'gym'] as const) {
      const wall = (await sprayWallMutations.createSprayWall(
        {},
        { input: { name: `${accessKind} feed wall`, angle: 40 } },
        { userId: ownerId, isAuthenticated: true, connectionId: ownerId },
      )) as { uuid: string };
      await db
        .update(userBoards)
        .set({ isPublic: accessKind === 'community', gymId: accessKind === 'gym' ? gym.id : null })
        .where(eq(userBoards.uuid, wall.uuid));
      const [wallRecord] = await db.select().from(sprayWalls).where(eq(sprayWalls.boardUuid, wall.uuid));
      const [version] = await db
        .insert(sprayWallVersions)
        .values({
          wallId: wallRecord.id,
          versionNumber: 1,
          status: 'draft',
          photoKey: `spray-walls/${wall.uuid}/photo.jpg`,
          photoWidth: 800,
          photoHeight: 600,
        })
        .returning();
      const detectionId = randomUUID();
      await db.insert(sprayWallDetections).values({
        id: detectionId,
        wallId: wallRecord.id,
        versionId: version.id,
        requestedBy: recipientId,
        photoKey: `spray-walls/${wall.uuid}/photo.jpg`,
        photoWidth: 800,
        photoHeight: 600,
        modelVersion: 'test',
        weightsSha256: 'test',
        jobId: randomUUID(),
        status: 'done',
      });
      sources.push({ detectionId, wallUuid: wall.uuid });
    }
    const makeTargets = (): Parameters<typeof enrichSprayNotificationTargets>[0] =>
      sources.map((source) => ({ uuid: source.detectionId, type: 'spray_wall_detection_completed' }));
    const firstFeed = makeTargets();
    await enrichSprayNotificationTargets(firstFeed, recipientId);
    expect(firstFeed.map((target) => target.sprayWallUuid)).toEqual(sources.map((source) => source.wallUuid));
    await db.delete(communityRoles).where(eq(communityRoles.userId, recipientId));
    const refreshedFeed = makeTargets();
    // The same recipient/session must not keep permissions from its previous feed read.
    await enrichSprayNotificationTargets(refreshedFeed, recipientId);
    expect(refreshedFeed[0]).toEqual({ uuid: sources[0].detectionId, type: 'spray_wall_detection_completed' });
    expect(refreshedFeed[1]).toMatchObject({ sprayWallUuid: sources[1].wallUuid, isSprayReset: false });
  });

  it.each([
    { name: 'initial import', predecessor: 'none', expectedReset: false },
    { name: 'initial import after an unpublished draft', predecessor: 'unpublished', expectedReset: false },
    { name: 'reset after a published version', predecessor: 'published', expectedReset: true },
  ] as const)(
    'keeps $name classification after publication and supersession',
    async ({ predecessor, expectedReset }) => {
      const userId = randomUUID();
      await db.insert(users).values({ id: userId, name: 'History tester', email: `${userId}@example.test` });
      const wall = (await sprayWallMutations.createSprayWall(
        {},
        { input: { name: 'Notification history wall', angle: 40 } },
        { userId, isAuthenticated: true, connectionId: userId },
      )) as { uuid: string };
      const [source] = await db.select().from(sprayWalls).where(eq(sprayWalls.boardUuid, wall.uuid));
      if (predecessor !== 'none') {
        const [previous] = await db
          .insert(sprayWallVersions)
          .values({
            wallId: source.id,
            versionNumber: 1,
            status: 'superseded',
            publishedAt: predecessor === 'published' ? new Date() : null,
          })
          .returning();
        if (expectedReset) {
          await db.update(sprayWalls).set({ currentVersionId: previous.id }).where(eq(sprayWalls.id, source.id));
        }
      }
      const [version] = await db
        .insert(sprayWallVersions)
        .values({
          wallId: source.id,
          versionNumber: predecessor === 'none' ? 1 : 2,
          status: 'draft',
          photoKey: `spray-walls/${wall.uuid}/photo.jpg`,
          photoWidth: 800,
          photoHeight: 600,
        })
        .returning();
      const detectionId = randomUUID();
      await db.insert(sprayWallDetections).values({
        id: detectionId,
        wallId: source.id,
        versionId: version.id,
        requestedBy: userId,
        photoKey: version.photoKey!,
        photoWidth: 800,
        photoHeight: 600,
        modelVersion: 'test',
        weightsSha256: 'test',
        jobId: randomUUID(),
        status: 'done',
        finishedAt: new Date(),
      });
      const event = await completionNotification(detectionId);
      expect(event?.notification).toMatchObject({ isSprayReset: expectedReset, sprayVersionId: String(version.id) });

      const assertTarget = async () => {
        const target: {
          uuid: string;
          type: string;
          isSprayReset?: boolean | null;
          sprayVersionId?: string | null;
          sprayWallUuid?: string | null;
        } = { uuid: detectionId, type: 'spray_wall_detection_completed' };
        await enrichSprayNotificationTargets([target], userId);
        expect(target).toMatchObject({
          isSprayReset: expectedReset,
          sprayVersionId: String(version.id),
          sprayWallUuid: wall.uuid,
        });
      };
      await assertTarget();
      await db
        .update(sprayWallVersions)
        .set({ status: 'published', publishedAt: new Date() })
        .where(eq(sprayWallVersions.id, version.id));
      await db.update(sprayWalls).set({ currentVersionId: version.id }).where(eq(sprayWalls.id, source.id));
      await assertTarget();

      await db.update(sprayWallVersions).set({ status: 'superseded' }).where(eq(sprayWallVersions.id, version.id));
      const [nextVersion] = await db
        .insert(sprayWallVersions)
        .values({
          wallId: source.id,
          versionNumber: version.versionNumber + 1,
          status: 'published',
          publishedAt: new Date(),
        })
        .returning();
      await db.update(sprayWalls).set({ currentVersionId: nextVersion.id }).where(eq(sprayWalls.id, source.id));
      await assertTarget();
    },
  );
});
