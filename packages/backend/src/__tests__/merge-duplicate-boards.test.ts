import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { and, eq, inArray } from 'drizzle-orm';
import { emptyKioskLayout, type KioskLayout } from '@boardsesh/kiosk';
import * as tables from '@boardsesh/db/schema';
import type { ConnectionContext, ClimbQueueItem } from '@boardsesh/shared-schema';
import { db, runWithDatabaseTransaction } from '../db/client';
import {
  mergeDuplicateBoards,
  mergeKioskBoardReferences,
  type MergeDuplicateBoardsInput,
} from '../services/merge-duplicate-boards';
import { findActiveBoardsBySerial } from '../graphql/resolvers/board-presence/shared';
import { boardRepairStateHash } from '../services/board-repair-state';
import * as preview from '../services/board-queue-preview';
import * as privacy from '../services/board-session-privacy';
import { pubsub } from '../pubsub';
import { roomManager } from '../services/room-manager';
import { SYSTEM_USER_ID } from '@boardsesh/db/queries';
import { settleDirectoryNoticePublishes } from '../graphql/resolvers/social/directory-reports/notices';
import { __resetDirectoryReportsFlagForTests } from '../services/directory-reports-flag';

const createdUsers: string[] = [];
const systemBoardUuids: string[] = [];
const savedFlagOverrides = process.env.FEATURE_FLAG_OVERRIDES;
let context: ConnectionContext;
let gym: typeof tables.gyms.$inferSelect;
let boards: (typeof tables.userBoards.$inferSelect)[];

async function stateInput(): Promise<MergeDuplicateBoardsInput> {
  const currentBoards = await db
    .select()
    .from(tables.userBoards)
    .where(
      inArray(
        tables.userBoards.uuid,
        boards.map((board) => board.uuid),
      ),
    );
  const policies = await db
    .select()
    .from(tables.resourcePrivacy)
    .where(
      and(
        eq(tables.resourcePrivacy.kind, 'board'),
        inArray(
          tables.resourcePrivacy.resourceId,
          boards.map((board) => board.uuid),
        ),
      ),
    );
  return {
    gymUuid: gym.uuid,
    canonicalBoardUuid: boards[0]!.uuid,
    duplicateBoardUuids: boards.slice(1).map((board) => board.uuid),
    reason: 'Confirmed same physical MoonBoard at Telefonplan.',
    allowOwnershipChange: true,
    expectedStates: currentBoards.map((board) => ({
      boardUuid: board.uuid,
      stateHash: boardRepairStateHash(
        board,
        policies.find((policy) => policy.resourceId === board.uuid),
      ),
    })),
  };
}

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.spyOn(preview, 'publishBoardQueuePreviewTombstoneForBoard').mockResolvedValue(undefined);
  vi.spyOn(privacy, 'notifyResourcePrivacyChanged').mockResolvedValue(undefined);
  vi.spyOn(preview, 'republishBoardQueuePreviewsForSession').mockResolvedValue(undefined);
  vi.spyOn(preview, 'republishBoardQueuePreviewForBoard').mockResolvedValue(undefined);
  const adminId = randomUUID();
  const firstOwner = randomUUID();
  const secondOwner = randomUUID();
  createdUsers.push(adminId, firstOwner, secondOwner);
  await db
    .insert(tables.users)
    .values([adminId, firstOwner, secondOwner].map((id) => ({ id, name: id, email: `${id}@test.com` })));
  await db
    .insert(tables.communityRoles)
    .values({ userId: adminId, role: 'admin', boardType: null, grantedBy: adminId });
  context = { connectionId: randomUUID(), userId: adminId, isAuthenticated: true };
  [gym] = await db
    .insert(tables.gyms)
    .values({ uuid: randomUUID(), slug: randomUUID(), ownerId: firstOwner, name: 'Telefonplan merge test' })
    .returning();
  boards = await db
    .insert(tables.userBoards)
    .values(
      [firstOwner, secondOwner].map((ownerId, index) => ({
        uuid: randomUUID(),
        slug: randomUUID(),
        ownerId,
        boardType: 'moonboard',
        layoutId: 5,
        sizeId: 1,
        setIds: index ? '23,22,21,20,19,18,17' : '17,18,19,20,21,22,23',
        name: `MoonBoard test ${index}`,
        gymId: gym.id,
        serialNumber: null,
        isPublic: true,
        isUnlisted: false,
        hideLocation: false,
        presenceSeq: index ? 120 : 90,
      })),
    )
    .returning();
});

afterEach(() => {
  if (savedFlagOverrides === undefined) delete process.env.FEATURE_FLAG_OVERRIDES;
  else process.env.FEATURE_FLAG_OVERRIDES = savedFlagOverrides;
  __resetDirectoryReportsFlagForTests();
});

afterAll(async () => {
  await settleDirectoryNoticePublishes();
  if (systemBoardUuids.length)
    await db.delete(tables.userBoards).where(inArray(tables.userBoards.uuid, systemBoardUuids));
  if (createdUsers.length) await db.delete(tables.users).where(inArray(tables.users.id, createdUsers));
});

describe('explicit public board merge', () => {
  it('merges serial-less normalized setups and preserves reporting provenance, sequence floors and old identities', async () => {
    await db.insert(tables.boardClimbEvents).values(
      boards.map((board, index) => ({
        boardId: board.id,
        boardType: 'moonboard',
        climbUuid: randomUUID(),
        angle: 40,
        userId: board.ownerId,
        seq: 1,
        frames: '',
        name: `Event ${index}`,
        reportingBoardId: board.id,
        reportingGymId: gym.id,
        confirmedAt: new Date().toISOString(),
      })),
    );
    await db.insert(tables.boardseshTicks).values({
      uuid: randomUUID(),
      userId: boards[1]!.ownerId,
      boardType: 'moonboard',
      climbUuid: randomUUID(),
      angle: 40,
      status: 'send',
      climbedAt: new Date().toISOString(),
      boardId: boards[1]!.id,
      reportingBoardId: boards[1]!.id,
      reportingGymId: gym.id,
    });
    await db
      .insert(tables.boardFollows)
      .values(boards.map((board) => ({ userId: context.userId!, boardUuid: board.uuid })));
    await db.insert(tables.userBoardActivity).values(
      boards.map((board, index) => ({
        userId: context.userId!,
        boardUuid: board.uuid,
        pinnedAt: index ? new Date('2026-01-01') : null,
        lastUsedAt: new Date(index ? '2026-02-01' : '2026-01-01'),
      })),
    );
    const result = await mergeDuplicateBoards(await stateInput(), context);
    expect(result.counts.climbEventsMoved).toBe(1);
    expect(result.counts.ticksMoved).toBe(1);
    const [tick] = await db
      .select()
      .from(tables.boardseshTicks)
      .where(eq(tables.boardseshTicks.boardId, boards[0]!.id));
    expect(tick).toMatchObject({ reportingBoardId: boards[1]!.id, reportingGymId: gym.id, userId: boards[1]!.ownerId });
    const events = await db
      .select()
      .from(tables.boardClimbEvents)
      .where(eq(tables.boardClimbEvents.boardId, boards[0]!.id));
    expect(events).toHaveLength(2);
    expect(new Set(events.map((event) => event.seq)).size).toBe(2);
    expect(Math.max(...events.map((event) => event.seq))).toBeGreaterThan(120);
    expect(new Set(events.map((event) => event.reportingBoardId))).toEqual(new Set(boards.map((board) => board.id)));
    const [duplicate] = await db.select().from(tables.userBoards).where(eq(tables.userBoards.uuid, boards[1]!.uuid));
    expect(duplicate!.deletedAt).not.toBeNull();
    expect(duplicate!.mergedIntoBoardUuid).toBe(boards[0]!.uuid);
    const follows = await db
      .select()
      .from(tables.boardFollows)
      .where(eq(tables.boardFollows.boardUuid, boards[0]!.uuid));
    expect(follows.map((follow) => follow.userId)).toEqual(
      expect.arrayContaining([context.userId, boards[1]!.ownerId]),
    );
    const [activity] = await db
      .select()
      .from(tables.userBoardActivity)
      .where(eq(tables.userBoardActivity.boardUuid, boards[0]!.uuid));
    expect(activity!.pinnedAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    const [audit] = await db
      .select()
      .from(tables.boardModerationEvents)
      .where(eq(tables.boardModerationEvents.boardId, boards[0]!.id));
    expect(audit).toMatchObject({
      actorUserId: context.userId,
      actorRole: 'global_admin',
      reason: 'Confirmed same physical MoonBoard at Telefonplan.',
      details: { merge: { duplicateBoardUuids: [boards[1]!.uuid] } },
    });
  });

  it.each([
    { missingSerial: null, sameOwner: false },
    { missingSerial: '', sameOwner: false },
    { missingSerial: '   ', sameOwner: false },
    { missingSerial: null, sameOwner: true },
  ])(
    'retains controller discovery when the survivor serial is $missingSerial and sameOwner=$sameOwner',
    async ({ missingSerial, sameOwner }) => {
      const serialNumber = `merge-controller-${randomUUID()}`;
      await db
        .update(tables.userBoards)
        .set({ serialNumber: missingSerial })
        .where(eq(tables.userBoards.id, boards[0]!.id));
      await db
        .update(tables.userBoards)
        .set({ serialNumber, ownerId: sameOwner ? boards[0]!.ownerId : boards[1]!.ownerId })
        .where(eq(tables.userBoards.id, boards[1]!.id));
      expect((await findActiveBoardsBySerial(serialNumber, db, 'moonboard')).map((board) => board.uuid)).toEqual([
        boards[1]!.uuid,
      ]);
      await mergeDuplicateBoards(await stateInput(), context);
      const [canonical] = await db.select().from(tables.userBoards).where(eq(tables.userBoards.id, boards[0]!.id));
      expect(canonical!.serialNumber).toBe(serialNumber);
      expect((await findActiveBoardsBySerial(serialNumber, db, 'moonboard')).map((board) => board.uuid)).toEqual([
        boards[0]!.uuid,
      ]);
    },
  );

  it('preserves an existing agreed survivor serial', async () => {
    const serialNumber = `merge-controller-${randomUUID()}`;
    await db
      .update(tables.userBoards)
      .set({ serialNumber })
      .where(
        inArray(
          tables.userBoards.id,
          boards.map((board) => board.id),
        ),
      );
    await mergeDuplicateBoards(await stateInput(), context);
    const [canonical] = await db.select().from(tables.userBoards).where(eq(tables.userBoards.id, boards[0]!.id));
    expect(canonical!.serialNumber).toBe(serialNumber);
    expect((await findActiveBoardsBySerial(serialNumber, db, 'moonboard')).map((board) => board.uuid)).toEqual([
      boards[0]!.uuid,
    ]);
  });

  it('refuses conflicting controller serials without changing either active board', async () => {
    const serialNumbers = boards.map(() => `merge-controller-${randomUUID()}`);
    for (const [index, board] of boards.entries())
      await db
        .update(tables.userBoards)
        .set({ serialNumber: serialNumbers[index]! })
        .where(eq(tables.userBoards.id, board.id));
    await expect(mergeDuplicateBoards(await stateInput(), context)).rejects.toThrow('different controller serials');
    for (const [index, board] of boards.entries()) {
      const candidates = await findActiveBoardsBySerial(serialNumbers[index]!, db, 'moonboard');
      expect(candidates.map((candidate) => candidate.uuid)).toEqual([board.uuid]);
    }
  });

  it('refuses a serial backfill that collides with the survivor owner’s unrelated active board', async () => {
    const serialNumber = `merge-controller-${randomUUID()}`;
    await db.update(tables.userBoards).set({ serialNumber }).where(eq(tables.userBoards.id, boards[1]!.id));
    const [unrelated] = await db
      .insert(tables.userBoards)
      .values({ ...boards[0]!, id: undefined, uuid: randomUUID(), slug: randomUUID(), serialNumber })
      .returning();
    await expect(mergeDuplicateBoards(await stateInput(), context)).rejects.toThrow('already has another active board');
    expect((await findActiveBoardsBySerial(serialNumber, db, 'moonboard')).map((board) => board.uuid).sort()).toEqual(
      [boards[1]!.uuid, unrelated!.uuid].sort(),
    );
    const [canonical] = await db.select().from(tables.userBoards).where(eq(tables.userBoards.id, boards[0]!.id));
    expect(canonical!.serialNumber).toBeNull();
  });

  it('retains legitimate serial reuse by another owner outside the merge', async () => {
    const serialNumber = `merge-controller-${randomUUID()}`;
    await db.update(tables.userBoards).set({ serialNumber }).where(eq(tables.userBoards.id, boards[1]!.id));
    const [unrelated] = await db
      .insert(tables.userBoards)
      .values({
        ...boards[0]!,
        id: undefined,
        uuid: randomUUID(),
        slug: randomUUID(),
        ownerId: context.userId!,
        serialNumber,
      })
      .returning();
    await mergeDuplicateBoards(await stateInput(), context);
    expect((await findActiveBoardsBySerial(serialNumber, db, 'moonboard')).map((board) => board.uuid).sort()).toEqual(
      [boards[0]!.uuid, unrelated!.uuid].sort(),
    );
    const [unchanged] = await db.select().from(tables.userBoards).where(eq(tables.userBoards.id, unrelated!.id));
    expect(unchanged).toEqual(unrelated);
  });

  it('rolls back an inherited serial when the outer receipt transaction fails', async () => {
    const serialNumber = `merge-controller-${randomUUID()}`;
    await db.update(tables.userBoards).set({ serialNumber }).where(eq(tables.userBoards.id, boards[1]!.id));
    const input = await stateInput();
    await expect(
      runWithDatabaseTransaction(async () => {
        await mergeDuplicateBoards(input, context);
        const [canonical] = await db.select().from(tables.userBoards).where(eq(tables.userBoards.id, boards[0]!.id));
        expect(canonical!.serialNumber).toBe(serialNumber);
        throw new Error('Receipt failed after serial transfer');
      }),
    ).rejects.toThrow('Receipt failed after serial transfer');
    const [canonical] = await db.select().from(tables.userBoards).where(eq(tables.userBoards.id, boards[0]!.id));
    expect(canonical!.serialNumber).toBeNull();
    expect((await findActiveBoardsBySerial(serialNumber, db, 'moonboard')).map((board) => board.uuid)).toEqual([
      boards[1]!.uuid,
    ]);
  });

  it('requires explicit acknowledgement when a different real creator loses editing ownership', async () => {
    const input = await stateInput();
    await expect(mergeDuplicateBoards({ ...input, allowOwnershipChange: undefined }, context)).rejects.toThrow(
      'allowOwnershipChange=true',
    );
    await expect(mergeDuplicateBoards({ ...input, allowOwnershipChange: false }, context)).rejects.toThrow(
      'lose editing ownership',
    );
    const [unchanged] = await db.select().from(tables.userBoards).where(eq(tables.userBoards.id, boards[1]!.id));
    expect(unchanged!.deletedAt).toBeNull();
    await mergeDuplicateBoards({ ...input, allowOwnershipChange: true }, context);
    const [canonical] = await db.select().from(tables.userBoards).where(eq(tables.userBoards.id, boards[0]!.id));
    expect(canonical!.ownerId).toBe(boards[0]!.ownerId);
    const [follow] = await db
      .select()
      .from(tables.boardFollows)
      .where(
        and(eq(tables.boardFollows.boardUuid, canonical!.uuid), eq(tables.boardFollows.userId, boards[1]!.ownerId)),
      );
    expect(follow).toBeDefined();
    const [audit] = await db
      .select()
      .from(tables.boardModerationEvents)
      .where(eq(tables.boardModerationEvents.boardId, canonical!.id));
    expect(audit!.details!.merge!.allowOwnershipChange).toBe(true);
  });

  it('requires acknowledgement before a SYSTEM survivor replaces a real creator’s ownership', async () => {
    await db
      .insert(tables.users)
      .values({ id: SYSTEM_USER_ID, email: 'system-merge-ownership@test.com' })
      .onConflictDoNothing();
    await db.update(tables.userBoards).set({ ownerId: SYSTEM_USER_ID }).where(eq(tables.userBoards.id, boards[0]!.id));
    systemBoardUuids.push(boards[0]!.uuid);
    await expect(
      mergeDuplicateBoards({ ...(await stateInput()), allowOwnershipChange: false }, context),
    ).rejects.toThrow('allowOwnershipChange=true');
  });

  it('needs no ownership acknowledgement for the same creator', async () => {
    await db
      .update(tables.userBoards)
      .set({ ownerId: boards[0]!.ownerId })
      .where(eq(tables.userBoards.id, boards[1]!.id));
    await mergeDuplicateBoards({ ...(await stateInput()), allowOwnershipChange: undefined }, context);
    const [audit] = await db
      .select()
      .from(tables.boardModerationEvents)
      .where(eq(tables.boardModerationEvents.boardId, boards[0]!.id));
    expect(audit!.details!.merge!.allowOwnershipChange).toBe(false);
  });

  it('invalidates only loser previews and republishes live survivor queues from pre-existing and moved sessions', async () => {
    vi.mocked(privacy.notifyResourcePrivacyChanged).mockRestore();
    vi.mocked(preview.publishBoardQueuePreviewTombstoneForBoard).mockRestore();
    vi.mocked(preview.republishBoardQueuePreviewsForSession).mockRestore();
    vi.mocked(preview.republishBoardQueuePreviewForBoard).mockRestore();
    const existingId = randomUUID();
    const movedId = randomUUID();
    const sessions = await db
      .insert(tables.boardSessions)
      .values([
        {
          id: existingId,
          boardPath: `/b/${boards[0]!.slug}/40`,
          boardId: boards[0]!.id,
          createdByUserId: boards[0]!.ownerId,
          isPublic: true,
        },
        {
          id: movedId,
          boardPath: `/b/${boards[1]!.slug}/40`,
          boardId: boards[1]!.id,
          createdByUserId: boards[1]!.ownerId,
          isPublic: true,
        },
      ])
      .returning();
    const item: ClimbQueueItem = {
      uuid: randomUUID(),
      climb: {
        uuid: randomUUID(),
        setter_username: 'Setter',
        name: 'Queue climb',
        frames: 'p1r12',
        angle: 40,
        ascensionist_count: 0,
        difficulty: 'V0',
        quality_average: '0',
        stars: 0,
        difficulty_error: '0',
        benchmark_difficulty: null,
      },
    };
    const queue: Awaited<ReturnType<typeof roomManager.getQueueState>> = {
      queue: [item],
      currentClimbQueueItem: item,
      sequence: 1,
      stateHash: 'queue',
      stateHashOrdered: 'queue',
      version: 1,
      historyCount: 0,
      currentChangedAt: null,
    };
    vi.spyOn(roomManager, 'getQueueState').mockResolvedValue(queue);
    vi.spyOn(pubsub, 'getSessionBoard').mockImplementation(async (sessionId) =>
      String(sessionId === movedId ? boards[1]!.id : boards[0]!.id),
    );
    vi.spyOn(pubsub, 'getBoardSession').mockImplementation(async (boardId) =>
      boardId === String(boards[0]!.id) ? existingId : movedId,
    );
    const published = vi.spyOn(pubsub, 'publishBoardQueuePreview').mockImplementation(() => {});
    const republished = vi.spyOn(preview, 'republishBoardQueuePreviewsForSession');
    const notified = vi.spyOn(privacy, 'notifyResourcePrivacyChanged');
    try {
      await mergeDuplicateBoards(await stateInput(), context);
      await vi.waitFor(() => expect(republished).toHaveBeenCalledTimes(2));
      await vi.waitFor(() =>
        expect(published.mock.calls.filter(([boardId]) => boardId === String(boards[0]!.id))).toHaveLength(3),
      );
      expect(republished).toHaveBeenCalledWith(existingId, boards[0]!.id);
      expect(republished).toHaveBeenCalledWith(movedId, boards[0]!.id);
      expect(notified).toHaveBeenCalledExactlyOnceWith('board', boards[1]!.uuid);
      const survivorPreviews = published.mock.calls
        .filter(([boardId]) => boardId === String(boards[0]!.id))
        .map(([, snapshot]) => snapshot);
      expect(
        survivorPreviews.every(
          (snapshot) => snapshot.current?.queueItemUuid === item.uuid && snapshot.queueLength === 1,
        ),
      ).toBe(true);
      expect(published.mock.calls.filter(([boardId]) => boardId === String(boards[1]!.id))).toHaveLength(1);
    } finally {
      await db.delete(tables.boardSessions).where(
        inArray(
          tables.boardSessions.id,
          sessions.map((session) => session.id),
        ),
      );
    }
  });

  it.each([
    'duplicate-slots',
    'broken-slot',
    'future-version',
    'invalid-toggle',
    'unknown-setting',
    'unknown-slot-setting',
  ] as const)('refuses affected invalid kiosk layouts without changing stored data: %s', async (kind) => {
    const raw: Record<string, unknown> = { ...emptyKioskLayout(), boards: [{ boardUuid: boards[1]!.uuid }] };
    if (kind === 'duplicate-slots') raw.boards = [{ boardUuid: boards[1]!.uuid }, { boardUuid: boards[1]!.uuid }];
    if (kind === 'broken-slot') raw.boards = [{ boardUuid: boards[1]!.uuid }, { boardUuid: 'broken' }];
    if (kind === 'future-version') raw.version = 99;
    if (kind === 'invalid-toggle') raw.showInstallQr = 'yes';
    if (kind === 'unknown-setting') raw.futureSetting = 'keep this';
    if (kind === 'unknown-slot-setting') raw.boards = [{ boardUuid: boards[1]!.uuid, futureSetting: 'keep this' }];
    const [kiosk] = await db
      .insert(tables.gymKiosks)
      .values({
        uuid: randomUUID(),
        gymId: gym.id,
        slug: randomUUID(),
        name: 'Invalid TV',
        layout: raw as unknown as KioskLayout,
      })
      .returning();
    await expect(mergeDuplicateBoards(await stateInput(), context)).rejects.toMatchObject({
      message: expect.stringContaining(kiosk!.uuid),
      extensions: { code: 'CONFLICT' },
    });
    const [unchanged] = await db.select().from(tables.gymKiosks).where(eq(tables.gymKiosks.id, kiosk!.id));
    expect(unchanged!.layout).toEqual(raw);
    const [duplicate] = await db.select().from(tables.userBoards).where(eq(tables.userBoards.id, boards[1]!.id));
    expect(duplicate!.deletedAt).toBeNull();
  });

  it('leaves unrelated invalid kiosk layouts untouched', async () => {
    const raw = { version: 99, boards: [{ boardUuid: randomUUID() }], futureSetting: 'keep this' };
    const [kiosk] = await db
      .insert(tables.gymKiosks)
      .values({
        uuid: randomUUID(),
        gymId: gym.id,
        slug: randomUUID(),
        name: 'Unrelated TV',
        layout: raw as unknown as KioskLayout,
      })
      .returning();
    await mergeDuplicateBoards(await stateInput(), context);
    const [unchanged] = await db.select().from(tables.gymKiosks).where(eq(tables.gymKiosks.id, kiosk!.id));
    expect(unchanged!.layout).toEqual(raw);
  });

  it('moves kiosk board/leaderboard references and collapses duplicate slots', async () => {
    const [kiosk] = await db
      .insert(tables.gymKiosks)
      .values({
        uuid: randomUUID(),
        gymId: gym.id,
        slug: randomUUID(),
        name: 'TV',
        layout: {
          ...emptyKioskLayout(),
          boards: boards.map((board) => ({ boardUuid: board.uuid })),
          leaderboard: { boardUuid: boards[1]!.uuid, period: 'week' },
          showInstallQr: true,
        },
      })
      .returning();
    await mergeDuplicateBoards(await stateInput(), context);
    const [updated] = await db.select().from(tables.gymKiosks).where(eq(tables.gymKiosks.id, kiosk!.id));
    expect(updated!.layout).toMatchObject({
      boards: [{ boardUuid: boards[0]!.uuid }],
      leaderboard: { boardUuid: boards[0]!.uuid, period: 'week' },
      showInstallQr: true,
    });
  });

  it('closes duplicate reports while retaining their original target IDs', async () => {
    const [report] = await db
      .insert(tables.directoryReports)
      .values({
        uuid: randomUUID(),
        targetKind: 'board',
        boardId: boards[1]!.id,
        gymIdAtReport: gym.id,
        reason: 'duplicate',
        duplicateOfBoardId: boards[0]!.id,
        routedTo: ['admin'],
      })
      .returning();
    const result = await mergeDuplicateBoards(await stateInput(), context);
    expect(result.reportsClosed).toBe(1);
    const [closed] = await db.select().from(tables.directoryReports).where(eq(tables.directoryReports.id, report!.id));
    expect(closed).toMatchObject({ boardId: boards[1]!.id, status: 'merged', duplicateOfBoardId: boards[0]!.id });
  });

  it('transfers one grade collection and refuses conflicting collection choices', async () => {
    const choices = await db
      .insert(tables.playlists)
      .values(
        [0, 1].map((index) => ({
          uuid: randomUUID(),
          boardType: 'moonboard',
          layoutId: 5,
          name: `Comparison ${index}`,
        })),
      )
      .returning();
    try {
      await db
        .insert(tables.gymBoardGradeCollections)
        .values(boards.map((board, index) => ({ boardId: board.id, playlistId: choices[index]!.id })));
      await expect(mergeDuplicateBoards(await stateInput(), context)).rejects.toThrow(
        'different grade comparison collections',
      );
      await db
        .delete(tables.gymBoardGradeCollections)
        .where(eq(tables.gymBoardGradeCollections.boardId, boards[0]!.id));
      await mergeDuplicateBoards(await stateInput(), context);
      const [selection] = await db
        .select()
        .from(tables.gymBoardGradeCollections)
        .where(eq(tables.gymBoardGradeCollections.boardId, boards[0]!.id));
      expect(selection!.playlistId).toBe(choices[1]!.id);
    } finally {
      await db.delete(tables.playlists).where(
        inArray(
          tables.playlists.id,
          choices.map((choice) => choice.id),
        ),
      );
    }
  });

  it('flattens pre-existing tombstones while keeping ordinary deletions unchanged', async () => {
    const [ancestor] = await db
      .insert(tables.userBoards)
      .values({
        ...boards[1]!,
        id: undefined,
        uuid: randomUUID(),
        slug: randomUUID(),
        deletedAt: new Date(),
        mergedIntoBoardUuid: boards[1]!.uuid,
      })
      .returning();
    await mergeDuplicateBoards(await stateInput(), context);
    const [flattened] = await db.select().from(tables.userBoards).where(eq(tables.userBoards.id, ancestor!.id));
    expect(flattened!.mergedIntoBoardUuid).toBe(boards[0]!.uuid);
  });

  it('refuses a concurrently held follower lock, then preserves its committed follow on retry', async () => {
    let markLocked = () => {};
    let releaseLock = () => {};
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const follower = db.transaction(async (transaction) => {
      await transaction.select().from(tables.userBoards).where(eq(tables.userBoards.id, boards[1]!.id)).for('share');
      markLocked();
      await released;
      await transaction.insert(tables.boardFollows).values({ userId: context.userId!, boardUuid: boards[1]!.uuid });
    });
    await locked;
    try {
      await expect(mergeDuplicateBoards(await stateInput(), context)).rejects.toMatchObject({
        extensions: { code: 'CONFLICT' },
      });
    } finally {
      releaseLock();
      await follower;
    }
    await mergeDuplicateBoards(await stateInput(), context);
    const [follow] = await db
      .select()
      .from(tables.boardFollows)
      .where(and(eq(tables.boardFollows.boardUuid, boards[0]!.uuid), eq(tables.boardFollows.userId, context.userId!)));
    expect(follow).toBeDefined();
  });

  it.each([false, true])(
    'keeps hidden location restrictions consistent with a survivor policy: %s',
    async (hasSurvivorPolicy) => {
      await db.update(tables.userBoards).set({ hideLocation: true }).where(eq(tables.userBoards.id, boards[1]!.id));
      if (hasSurvivorPolicy)
        await db.insert(tables.resourcePrivacy).values({
          kind: 'board',
          resourceId: boards[0]!.uuid,
          ownerId: boards[0]!.ownerId,
          audience: 'public',
          locationAudience: 'public',
          revision: 4,
        });
      await mergeDuplicateBoards(await stateInput(), context);
      const [canonical] = await db.select().from(tables.userBoards).where(eq(tables.userBoards.id, boards[0]!.id));
      expect(canonical!.hideLocation).toBe(true);
      const [policy] = await db
        .select()
        .from(tables.resourcePrivacy)
        .where(and(eq(tables.resourcePrivacy.kind, 'board'), eq(tables.resourcePrivacy.resourceId, boards[0]!.uuid)));
      if (hasSurvivorPolicy)
        expect(policy).toMatchObject({ audience: 'public', locationAudience: 'only_me', revision: 5 });
      else expect(policy).toBeUndefined();
    },
  );

  it('keeps earlier moderation evidence on the original duplicate', async () => {
    const [historical] = await db
      .insert(tables.boardModerationEvents)
      .values({
        boardId: boards[1]!.id,
        gymId: gym.id,
        actorUserId: context.userId!,
        actorRole: 'global_admin',
        action: 'edited_by_staff',
        reason: 'Original setup correction',
        details: { mutation: 'adminUpdateBoard', fields: ['layoutId'] },
      })
      .returning();
    await mergeDuplicateBoards(await stateInput(), context);
    const [unchanged] = await db
      .select()
      .from(tables.boardModerationEvents)
      .where(eq(tables.boardModerationEvents.id, historical!.id));
    expect(unchanged).toEqual(historical);
  });

  it('refuses a concurrently held session row before migrating any board history', async () => {
    const [session] = await db
      .insert(tables.boardSessions)
      .values({
        id: randomUUID(),
        boardPath: `/b/${boards[1]!.slug}/40`,
        boardId: boards[1]!.id,
        createdByUserId: boards[1]!.ownerId,
      })
      .returning();
    let markLocked = () => {};
    let releaseLock = () => {};
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const rebind = db.transaction(async (transaction) => {
      await transaction
        .select()
        .from(tables.boardSessions)
        .where(eq(tables.boardSessions.id, session!.id))
        .for('update');
      markLocked();
      await released;
    });
    await locked;
    try {
      await expect(mergeDuplicateBoards(await stateInput(), context)).rejects.toMatchObject({
        extensions: { code: 'CONFLICT' },
      });
    } finally {
      releaseLock();
      await rebind;
    }
    await mergeDuplicateBoards(await stateInput(), context);
    const [updated] = await db.select().from(tables.boardSessions).where(eq(tables.boardSessions.id, session!.id));
    expect(updated!.boardId).toBe(boards[0]!.id);
    await db.delete(tables.boardSessions).where(eq(tables.boardSessions.id, session!.id));
  });

  it.each(['actor', 'owner'] as const)('refuses a held %s user before taking board locks', async (heldUser) => {
    const userId = heldUser === 'actor' ? context.userId! : boards[1]!.ownerId;
    let markLocked = () => {};
    let releaseLock = () => {};
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const privacyChange = db.transaction(async (transaction) => {
      await transaction
        .select({ id: tables.users.id })
        .from(tables.users)
        .where(eq(tables.users.id, userId))
        .for('update');
      markLocked();
      await released;
    });
    await locked;
    try {
      await expect(mergeDuplicateBoards(await stateInput(), context)).rejects.toMatchObject({
        extensions: { code: 'CONFLICT' },
      });
      expect(preview.publishBoardQueuePreviewTombstoneForBoard).not.toHaveBeenCalled();
    } finally {
      releaseLock();
      await privacyChange;
    }
    await mergeDuplicateBoards(await stateInput(), context);
  });

  it('notifies each distinct real creator once, preserving the original loser target', async () => {
    process.env.FEATURE_FLAG_OVERRIDES = 'directory-reports';
    __resetDirectoryReportsFlagForTests();
    await db
      .insert(tables.users)
      .values({ id: SYSTEM_USER_ID, email: 'system-merge-notices@test.com' })
      .onConflictDoNothing();
    const extra = await db
      .insert(tables.userBoards)
      .values(
        [boards[1]!.ownerId, boards[0]!.ownerId, context.userId!, SYSTEM_USER_ID].map((ownerId) => ({
          ...boards[1]!,
          id: undefined,
          uuid: randomUUID(),
          slug: randomUUID(),
          ownerId,
        })),
      )
      .returning();
    systemBoardUuids.push(...extra.filter((board) => board.ownerId === SYSTEM_USER_ID).map((board) => board.uuid));
    boards.push(...extra);
    await mergeDuplicateBoards(await stateInput(), context);
    const notices = await db
      .select()
      .from(tables.notifications)
      .where(
        and(
          eq(tables.notifications.type, 'board_edited_by_staff'),
          inArray(
            tables.notifications.entityId,
            boards.map((board) => board.uuid),
          ),
        ),
      );
    expect(notices).toHaveLength(2);
    expect(notices.map((notice) => notice.recipientId).sort()).toEqual([boards[0]!.ownerId, boards[1]!.ownerId].sort());
    expect(notices.find((notice) => notice.recipientId === boards[1]!.ownerId)!.entityId).toBe(boards[1]!.uuid);
    const audits = await db
      .select()
      .from(tables.boardModerationEvents)
      .where(
        inArray(
          tables.boardModerationEvents.boardId,
          boards.map((board) => board.id),
        ),
      );
    expect(audits).toHaveLength(2);
    expect(
      audits.every(
        (audit) => audit.actorUserId === context.userId && audit.details?.merge?.canonicalBoardUuid === boards[0]!.uuid,
      ),
    ).toBe(true);
  });

  it('refuses stale state and leaves history unchanged', async () => {
    const input = await stateInput();
    await db
      .update(tables.userBoards)
      .set({ name: 'Changed after review' })
      .where(eq(tables.userBoards.id, boards[1]!.id));
    await expect(mergeDuplicateBoards(input, context)).rejects.toThrow('changed after inspection');
    const [duplicate] = await db.select().from(tables.userBoards).where(eq(tables.userBoards.id, boards[1]!.id));
    expect(duplicate!.deletedAt).toBeNull();
  });

  it.each(['layout', 'private', 'policy', 'grant', 'share', 'reporting'] as const)(
    'refuses unsupported %s state before mutating',
    async (kind) => {
      const duplicate = boards[1]!;
      if (kind === 'layout')
        await db.update(tables.userBoards).set({ layoutId: 2 }).where(eq(tables.userBoards.id, duplicate.id));
      if (kind === 'private')
        await db.update(tables.userBoards).set({ isPublic: false }).where(eq(tables.userBoards.id, duplicate.id));
      if (kind === 'policy')
        await db.insert(tables.resourcePrivacy).values({
          kind: 'board',
          resourceId: duplicate.uuid,
          ownerId: duplicate.ownerId,
          audience: 'public',
          locationAudience: 'only_me',
        });
      if (kind === 'grant')
        await db
          .insert(tables.resourceGrants)
          .values({ kind: 'board', resourceId: duplicate.uuid, userId: context.userId!, status: 'revoked' });
      if (kind === 'share')
        await db
          .insert(tables.boardShareLinks)
          .values({ token: randomUUID(), boardUuid: duplicate.uuid, createdBy: duplicate.ownerId });
      if (kind === 'reporting')
        await db
          .insert(tables.gymReportingBoardAliases)
          .values({ gymId: gym.id, boardId: duplicate.id, rootBoardId: boards[0]!.id, verifiedBy: context.userId! });
      await expect(mergeDuplicateBoards(await stateInput(), context)).rejects.toMatchObject({
        extensions: { code: 'CONFLICT' },
      });
      const [stillActive] = await db.select().from(tables.userBoards).where(eq(tables.userBoards.id, duplicate.id));
      expect(stillActive!.deletedAt).toBeNull();
      expect(preview.publishBoardQueuePreviewTombstoneForBoard).not.toHaveBeenCalled();
    },
  );

  it('refuses gym staff and board-scoped admins', async () => {
    await db
      .update(tables.communityRoles)
      .set({ boardType: 'moonboard' })
      .where(eq(tables.communityRoles.userId, context.userId!));
    await expect(mergeDuplicateBoards(await stateInput(), context)).rejects.toThrow('Admin role required');
    await expect(mergeDuplicateBoards(await stateInput(), { ...context, userId: gym.ownerId })).rejects.toThrow(
      'Admin role required',
    );
  });

  it('does not publish effects when its enclosing MCP transaction rolls back', async () => {
    process.env.FEATURE_FLAG_OVERRIDES = 'directory-reports';
    __resetDirectoryReportsFlagForTests();
    const input = await stateInput();
    await expect(
      runWithDatabaseTransaction(async () => {
        await mergeDuplicateBoards(input, context);
        expect(preview.publishBoardQueuePreviewTombstoneForBoard).not.toHaveBeenCalled();
        throw new Error('Receipt failed');
      }),
    ).rejects.toThrow('Receipt failed');
    expect(preview.publishBoardQueuePreviewTombstoneForBoard).not.toHaveBeenCalled();
    const [duplicate] = await db.select().from(tables.userBoards).where(eq(tables.userBoards.id, boards[1]!.id));
    expect(duplicate!.deletedAt).toBeNull();
    const notices = await db
      .select()
      .from(tables.notifications)
      .where(
        inArray(
          tables.notifications.entityId,
          boards.map((board) => board.uuid),
        ),
      );
    expect(notices).toHaveLength(0);
  });
});

it('preserves an all-boards leaderboard scope when rewriting a kiosk', () => {
  const layout = {
    ...emptyKioskLayout(),
    boards: boards.map((board) => ({ boardUuid: board.uuid })),
    leaderboard: { boardUuid: null, period: 'month' as const },
  };
  expect(
    mergeKioskBoardReferences(layout, new Set([boards[1]!.uuid]), boards[0]!.uuid).leaderboard?.boardUuid,
  ).toBeNull();
});
