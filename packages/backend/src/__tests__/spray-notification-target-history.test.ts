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
    expect(refreshedFeed[1]).toMatchObject({ sprayWallUuid: sources[1].wallUuid, sprayResetOfWallUuid: null });
  });

  async function completedDraft(userId: string, wallId: number, wallUuid: string, versionNumber: number) {
    const [version] = await db
      .insert(sprayWallVersions)
      .values({
        wallId,
        versionNumber,
        status: 'draft',
        photoKey: `spray-walls/${wallUuid}/photo-${versionNumber}.jpg`,
        photoWidth: 800,
        photoHeight: 600,
      })
      .returning();
    const detectionId = randomUUID();
    await db.insert(sprayWallDetections).values({
      id: detectionId,
      wallId,
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
    return { version, detectionId };
  }

  async function historyWall(userId: string, name: string) {
    const wall = (await sprayWallMutations.createSprayWall(
      {},
      { input: { name, angle: 40 } },
      { userId, isAuthenticated: true, connectionId: userId },
    )) as { uuid: string };
    const [record] = await db.select().from(sprayWalls).where(eq(sprayWalls.boardUuid, wall.uuid));
    return record;
  }

  async function enrichedTarget(detectionId: string, userId: string) {
    const target: Parameters<typeof enrichSprayNotificationTargets>[0][number] = {
      uuid: detectionId,
      type: 'spray_wall_detection_completed',
    };
    await enrichSprayNotificationTargets([target], userId);
    return target;
  }

  it.each([
    { name: 'a new wall', isClone: false },
    { name: 'a reset clone', isClone: true },
  ])('links $name to the wall it replaces until its first publish', async ({ isClone }) => {
    const userId = randomUUID();
    await db.insert(users).values({ id: userId, name: 'History tester', email: `${userId}@example.test` });
    const replaced = await historyWall(userId, 'Replaced wall');
    const wall = await historyWall(userId, 'Notification history wall');
    if (isClone) {
      await db.update(sprayWalls).set({ resetFromWallId: replaced.id }).where(eq(sprayWalls.id, wall.id));
    }
    const expectedLink = isClone ? replaced.boardUuid : null;
    const { version, detectionId } = await completedDraft(userId, wall.id, wall.boardUuid, 1);

    const event = await completionNotification(detectionId);
    expect(event?.notification).toMatchObject({
      sprayResetOfWallUuid: expectedLink,
      sprayVersionId: String(version.id),
    });
    expect(await enrichedTarget(detectionId, userId)).toMatchObject({
      sprayResetOfWallUuid: expectedLink,
      sprayVersionId: String(version.id),
      sprayWallUuid: wall.boardUuid,
    });

    // Once published the clone is a wall in its own right: reopening the reset
    // would land on the archived wall, so the feed entry drops the link.
    await db
      .update(sprayWallVersions)
      .set({ status: 'published', publishedAt: new Date() })
      .where(eq(sprayWallVersions.id, version.id));
    await db.update(sprayWalls).set({ currentVersionId: version.id }).where(eq(sprayWalls.id, wall.id));
    expect(await enrichedTarget(detectionId, userId)).toMatchObject({
      sprayResetOfWallUuid: null,
      sprayVersionId: String(version.id),
      sprayWallUuid: wall.boardUuid,
    });
  });

  it('sends nothing for a draft left on a published wall', async () => {
    const userId = randomUUID();
    await db.insert(users).values({ id: userId, name: 'History tester', email: `${userId}@example.test` });
    const wall = await historyWall(userId, 'Published history wall');
    const [published] = await db
      .insert(sprayWallVersions)
      .values({ wallId: wall.id, versionNumber: 1, status: 'published', publishedAt: new Date() })
      .returning();
    await db.update(sprayWalls).set({ currentVersionId: published.id }).where(eq(sprayWalls.id, wall.id));
    const { detectionId } = await completedDraft(userId, wall.id, wall.boardUuid, 2);
    expect(await completionNotification(detectionId)).toBeNull();
  });
});
