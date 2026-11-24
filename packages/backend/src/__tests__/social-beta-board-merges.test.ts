import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { and, eq, inArray } from 'drizzle-orm';
import * as tables from '@boardsesh/db/schema';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { socialCommentMutations } from '../graphql/resolvers/social/comments';
import { socialVoteMutations } from '../graphql/resolvers/social/votes';
import { tickMutations } from '../graphql/resolvers/ticks/mutations';
import * as entityValidation from '../graphql/resolvers/social/entity-validation';
import * as activityPrivacy from '../graphql/resolvers/shared/activity-privacy';
import * as boardReference from '../services/board-reference-lock';
import * as instagram from '../utils/instagram-beta-validation';
import * as thumbnails from '../lib/beta-link-thumbnails';
import * as preview from '../services/board-queue-preview';
import * as privacy from '../services/board-session-privacy';
import { mergeDuplicateBoards } from '../services/merge-duplicate-boards';
import { boardRepairStateHash } from '../services/board-repair-state';
import { inspectGymDuplicates, mergeAdminGyms } from '../mcp/gyms/admin-domain';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

let adminId: string;
let ownerId: string;
let actorId: string;
let context: ConnectionContext;
let actor: ConnectionContext;
let gym: typeof tables.gyms.$inferSelect;
let duplicateGym: typeof tables.gyms.$inferSelect;
let boards: (typeof tables.userBoards.$inferSelect)[];

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.spyOn(preview, 'publishBoardQueuePreviewTombstoneForBoard').mockResolvedValue(undefined);
  vi.spyOn(privacy, 'notifyResourcePrivacyChanged').mockResolvedValue(undefined);
  adminId = randomUUID();
  ownerId = randomUUID();
  actorId = randomUUID();
  context = { connectionId: randomUUID(), userId: adminId, isAuthenticated: true };
  actor = { connectionId: randomUUID(), userId: actorId, isAuthenticated: true };
  await db
    .insert(tables.users)
    .values([adminId, ownerId, actorId].map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(tables.communityRoles).values({ userId: adminId, role: 'admin', boardType: null });
  const gyms = await db
    .insert(tables.gyms)
    .values([
      { uuid: randomUUID(), slug: randomUUID(), name: 'Main gym', ownerId, latitude: 59.3, longitude: 18 },
      { uuid: randomUUID(), slug: randomUUID(), name: 'Duplicate gym', ownerId, latitude: 59.30001, longitude: 18 },
    ])
    .returning();
  [gym, duplicateGym] = [gyms[0]!, gyms[1]!];
  boards = await db
    .insert(tables.userBoards)
    .values(
      [0, 1].map((index) => ({
        uuid: randomUUID(),
        slug: randomUUID(),
        ownerId,
        name: `Public MoonBoard ${index}`,
        boardType: 'moonboard',
        layoutId: 5,
        sizeId: 1,
        setIds: '17,18,19,20,21,22,23',
        gymId: gym.id,
        isPublic: true,
      })),
    )
    .returning();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.delete(tables.users).where(inArray(tables.users.id, [adminId, ownerId, actorId]));
});

async function mergeBoards() {
  const current = await db
    .select()
    .from(tables.userBoards)
    .where(
      inArray(
        tables.userBoards.id,
        boards.map((board) => board.id),
      ),
    );
  return mergeDuplicateBoards(
    {
      gymUuid: gym.uuid,
      canonicalBoardUuid: boards[0]!.uuid,
      duplicateBoardUuids: [boards[1]!.uuid],
      reason: 'Operator confirmed these are the same physical wall.',
      expectedStates: current.map((board) => ({
        boardUuid: board.uuid,
        stateHash: boardRepairStateHash(board, undefined),
      })),
    },
    context,
  );
}

async function mergeGyms() {
  const inspection = await inspectGymDuplicates([gym.uuid, duplicateGym.uuid], context);
  return mergeAdminGyms(
    {
      canonicalGymUuid: gym.uuid,
      duplicateGymUuids: [duplicateGym.uuid],
      expectedStates: inspection.gyms.map((entry) => ({ gymUuid: entry.gymUuid, stateHash: entry.stateHash })),
      reason: 'Operator confirmed these pins identify the same physical gym.',
      allowSystemCanonicalOverride: false,
    },
    context,
  );
}

describe('social writes serialize with explicit board and gym merges', () => {
  it.each(['comment', 'vote'] as const)(
    'rechecks %s visibility through the held transaction without acquiring another pool connection',
    async (kind) => {
      let insideTransaction = false;
      const transaction = db.transaction.bind(db);
      const canRead = activityPrivacy.canReadSocialEntity;
      vi.spyOn(db, 'transaction').mockImplementation(async (work, options) =>
        transaction(async (executor) => {
          insideTransaction = true;
          try {
            return await work(executor);
          } finally {
            insideTransaction = false;
          }
        }, options),
      );
      vi.spyOn(activityPrivacy, 'canReadSocialEntity').mockImplementation(async (...arguments_) => {
        if (insideTransaction) throw new Error('A global visibility read acquired a second connection.');
        return canRead(...arguments_);
      });
      if (kind === 'comment')
        await expect(
          socialCommentMutations.addComment(
            {},
            {
              input: {
                entityType: 'board',
                entityId: boards[1]!.uuid,
                body: 'One connection owns this visibility check.',
              },
            },
            actor,
          ),
        ).resolves.toMatchObject({ entityId: boards[1]!.uuid });
      else
        await expect(
          socialVoteMutations.vote({}, { input: { entityType: 'board', entityId: boards[1]!.uuid, value: 1 } }, actor),
        ).resolves.toMatchObject({ userVote: 1 });
    },
  );

  it.each(['comment', 'vote'] as const)('refuses a stale board %s after validation loses to merge', async (kind) => {
    const validated = deferred();
    const release = deferred();
    const validate = entityValidation.validateEntityExists;
    vi.spyOn(entityValidation, 'validateEntityExists').mockImplementation(async (...arguments_) => {
      await validate(...arguments_);
      validated.resolve();
      await release.promise;
    });
    const pending =
      kind === 'comment'
        ? socialCommentMutations.addComment(
            {},
            { input: { entityType: 'board', entityId: boards[1]!.uuid, body: 'Keep this comment on the wall.' } },
            actor,
          )
        : socialVoteMutations.vote({}, { input: { entityType: 'board', entityId: boards[1]!.uuid, value: 1 } }, actor);
    const settled = pending.then(
      () => null,
      (error: unknown) => error,
    );
    try {
      await validated.promise;
      await mergeBoards();
      release.resolve();
      expect(await settled).toBeInstanceOf(Error);
      expect(await db.select().from(tables.comments).where(eq(tables.comments.entityId, boards[1]!.uuid))).toHaveLength(
        0,
      );
      expect(await db.select().from(tables.votes).where(eq(tables.votes.entityId, boards[1]!.uuid))).toHaveLength(0);
    } finally {
      release.resolve();
      await settled;
    }
  });

  it.each(['comment', 'vote'] as const)('refuses a stale gym %s after validation loses to merge', async (kind) => {
    const validated = deferred();
    const release = deferred();
    const validate = entityValidation.validateEntityExists;
    vi.spyOn(entityValidation, 'validateEntityExists').mockImplementation(async (...arguments_) => {
      await validate(...arguments_);
      validated.resolve();
      await release.promise;
    });
    const pending =
      kind === 'comment'
        ? socialCommentMutations.addComment(
            {},
            { input: { entityType: 'gym', entityId: duplicateGym.uuid, body: 'Our gym crew climbs here.' } },
            actor,
          )
        : socialVoteMutations.vote({}, { input: { entityType: 'gym', entityId: duplicateGym.uuid, value: 1 } }, actor);
    const settled = pending.then(
      () => null,
      (error: unknown) => error,
    );
    try {
      await validated.promise;
      await mergeGyms();
      release.resolve();
      expect(await settled).toBeInstanceOf(Error);
      expect(
        await db.select().from(tables.comments).where(eq(tables.comments.entityId, duplicateGym.uuid)),
      ).toHaveLength(0);
      expect(await db.select().from(tables.votes).where(eq(tables.votes.entityId, duplicateGym.uuid))).toHaveLength(0);
    } finally {
      release.resolve();
      await settled;
    }
  });

  it.each(['comment', 'vote'] as const)('preserves a %s that obtains its board lock before the merge', async (kind) => {
    const locked = deferred();
    const release = deferred();
    const lockBoard = boardReference.lockActiveBoardForWrite;
    vi.spyOn(boardReference, 'lockActiveBoardForWrite').mockImplementation(async (...arguments_) => {
      const board = await lockBoard(...arguments_);
      locked.resolve();
      await release.promise;
      return board;
    });
    const pending =
      kind === 'comment'
        ? socialCommentMutations.addComment(
            {},
            { input: { entityType: 'board', entityId: boards[1]!.uuid, body: 'The comment survives this merge.' } },
            actor,
          )
        : socialVoteMutations.vote({}, { input: { entityType: 'board', entityId: boards[1]!.uuid, value: 1 } }, actor);
    try {
      await locked.promise;
      await expect(mergeBoards()).rejects.toMatchObject({ extensions: { code: 'CONFLICT' } });
      release.resolve();
      await pending;
      await mergeBoards();
      const references =
        kind === 'comment'
          ? await db.select().from(tables.comments).where(eq(tables.comments.entityId, boards[0]!.uuid))
          : await db
              .select()
              .from(tables.votes)
              .where(and(eq(tables.votes.entityId, boards[0]!.uuid), eq(tables.votes.userId, actorId)));
      expect(references).toHaveLength(1);
    } finally {
      release.resolve();
      await Promise.allSettled([pending]);
    }
  });
});

describe('standalone beta attachment and merge', () => {
  it('uses the tick’s current board when a merge commits during remote video validation', async () => {
    const tickUuid = randomUUID();
    const climbUuid = randomUUID();
    const videoValidated = deferred();
    const releaseVideo = deferred();
    await db.insert(tables.boardseshTicks).values({
      uuid: tickUuid,
      userId: actorId,
      boardType: 'moonboard',
      climbUuid,
      angle: 40,
      status: 'send',
      climbedAt: new Date().toISOString(),
      boardId: boards[1]!.id,
      reportingBoardId: boards[1]!.id,
      reportingGymId: gym.id,
    });
    vi.spyOn(thumbnails, 'isS3Configured').mockReturnValue(false);
    vi.spyOn(instagram, 'validateInstagramBetaLink').mockImplementation(async () => {
      videoValidated.resolve();
      await releaseVideo.promise;
      return { mediaId: 'MergeSafeBeta', username: 'climber', imageUrl: null };
    });
    const link = `https://www.instagram.com/reel/${randomUUID().replaceAll('-', '')}/`;
    const pending = tickMutations.attachBetaLink(
      {},
      { input: { boardType: 'moonboard', climbUuid, tickUuid, angle: 40, link } },
      actor,
    );
    try {
      await videoValidated.promise;
      await mergeBoards();
      releaseVideo.resolve();
      await expect(pending).resolves.toBe(true);
      const [beta] = await db.select().from(tables.boardBetaLinks).where(eq(tables.boardBetaLinks.tickUuid, tickUuid));
      expect(beta).toMatchObject({ boardId: boards[0]!.id, tickUuid, angle: 40 });
      const [tick] = await db.select().from(tables.boardseshTicks).where(eq(tables.boardseshTicks.uuid, tickUuid));
      expect(tick).toMatchObject({ boardId: boards[0]!.id, reportingBoardId: boards[1]!.id, reportingGymId: gym.id });
    } finally {
      releaseVideo.resolve();
      await Promise.allSettled([pending]);
    }
  });
});
