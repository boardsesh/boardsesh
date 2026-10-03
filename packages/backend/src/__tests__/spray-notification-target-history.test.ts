import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { sprayWallDetections, sprayWalls, sprayWallVersions, users } from '@boardsesh/db/schema';
import { db } from '../db/client';
import { sprayWallMutations } from '../graphql/resolvers/board/spray-walls';
import { enrichSprayNotificationTargets } from '../graphql/resolvers/social/spray-notification-targets';
import { completionNotification } from '../services/spray-detection-notifications';

vi.mock('../utils/redis-rate-limiter', () => ({ checkRateLimitRedis: vi.fn().mockResolvedValue(undefined) }));

describe('spray notification version history', () => {
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
