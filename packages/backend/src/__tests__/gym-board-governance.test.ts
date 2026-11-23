import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import { v4 as uuidv4 } from 'uuid';
import { eq, sql } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import { rowsFromResult } from '@boardsesh/db/client';
import * as dbSchema from '@boardsesh/db/schema';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { socialBoardMutations, socialBoardQueries, updateBoardRecord } from '../graphql/resolvers/social/boards';
import { enrichGym, gymListingState, socialGymMutations } from '../graphql/resolvers/social/gyms';
import {
  socialGymStrayBoardMutations,
  socialGymStrayBoardQueries,
  type StrayBoardResult,
} from '../graphql/resolvers/social/gym-stray-boards';
import { socialLocationSyncFreezeMutations } from '../graphql/resolvers/social/location-sync-freezes';
import { resetAllRateLimits } from '../utils/rate-limiter';
import { createBarrier, createValueBarrier, handleLater } from './helpers/concurrency';

/**
 * The gym and board power model (docs/product/gym-board-governance.md, decision 1):
 * gym staff take a climber's board off their listing rather than delete it, the
 * removal sticks against the location sync and the creator's own re-link, staff
 * can put it back, and every board and gym says who can do what.
 */

const SYSTEM_OWNER = '00000000-0000-0000-0000-000000000000';
const CREATOR = 'gov-creator';
const GYM_OWNER = 'gov-gym-owner';
const GYM_ADMIN = 'gov-gym-admin';
const GYM_EDITOR = 'gov-gym-editor';
const KILTER_LEADER = 'gov-kilter-leader';
const TENSION_LEADER = 'gov-tension-leader';
const GLOBAL_ADMIN = 'gov-global-admin';
const OUTSIDER = 'gov-outsider';
const ALL_USERS = [
  SYSTEM_OWNER,
  CREATOR,
  GYM_OWNER,
  GYM_ADMIN,
  GYM_EDITOR,
  KILTER_LEADER,
  TENSION_LEADER,
  GLOBAL_ADMIN,
  OUTSIDER,
];

const BASE = { latitude: 47.0, longitude: 8.0 };
const LAT_60M = 47.0 + 0.00054; // ~60 m north, inside the 150 m radius

let connectionCounter = 0;
const authCtx = (userId: string): ConnectionContext =>
  ({ connectionId: `conn-${userId}-${connectionCounter++}`, isAuthenticated: true, userId }) as ConnectionContext;
const anonCtx = (): ConnectionContext =>
  ({ connectionId: `conn-anon-${connectionCounter++}`, isAuthenticated: false }) as ConnectionContext;

type GymRef = { id: number; uuid: string };
type BoardRef = { id: number; uuid: string };

async function insertGym(ownerId: string, name = 'Governance Gym'): Promise<GymRef> {
  const uuid = uuidv4();
  const [gym] = await db
    .insert(dbSchema.gyms)
    .values({ uuid, slug: uuid, name, ownerId, isPublic: true, ...BASE })
    .returning({ id: dbSchema.gyms.id, uuid: dbSchema.gyms.uuid });
  return gym;
}

let boardConfigCounter = 0;
async function insertBoard(ownerId: string, gymId: number | null, boardType = 'kilter'): Promise<BoardRef> {
  const uuid = uuidv4();
  const [board] = await db
    .insert(dbSchema.userBoards)
    .values({
      uuid,
      slug: uuid,
      name: `Board ${boardConfigCounter}`,
      ownerId,
      boardType,
      layoutId: 1,
      sizeId: 900 + boardConfigCounter++,
      setIds: '1,2',
      gymId,
      isPublic: true,
      latitude: LAT_60M,
      longitude: BASE.longitude,
    })
    .returning({ id: dbSchema.userBoards.id, uuid: dbSchema.userBoards.uuid });
  return board;
}

async function boardRow(boardId: number) {
  const [board] = await db.select().from(dbSchema.userBoards).where(eq(dbSchema.userBoards.id, boardId));
  return board;
}

async function eventsFor(boardId: number) {
  return db
    .select()
    .from(dbSchema.boardModerationEvents)
    .where(eq(dbSchema.boardModerationEvents.boardId, boardId))
    .orderBy(dbSchema.boardModerationEvents.id);
}

const detach = (gymUuid: string, boardUuid: string, userId: string) =>
  socialGymStrayBoardMutations.detachBoardFromGym(null, { input: { gymUuid, boardUuid } }, authCtx(userId));
const attach = (gymUuid: string, boardUuid: string, userId: string) =>
  socialGymStrayBoardMutations.attachBoardToGym(null, { input: { gymUuid, boardUuid } }, authCtx(userId));
const linkBoardToGym = (boardUuid: string, gymUuid: string | null, userId: string) =>
  socialGymMutations.linkBoardToGym(null, { input: { boardUuid, gymUuid } }, authCtx(userId));
const strayBoardsForGym = (gymUuid: string, userId: string) =>
  socialGymStrayBoardQueries.strayBoardsForGym(null, { gymUuid }, authCtx(userId)) as Promise<StrayBoardResult[]>;

let gym: GymRef;
let climberBoard: BoardRef;
let systemBoard: BoardRef;

beforeEach(async () => {
  resetAllRateLimits();
  await db.execute(sql`
    TRUNCATE TABLE
      "community_roles", "gym_members", "gym_follows", "gym_claims", "gym_owner_reassignments",
      "user_boards", "gyms"
    RESTART IDENTITY CASCADE
  `);
  await db
    .insert(dbSchema.users)
    .values(ALL_USERS.map((id) => ({ id, email: `${id}@test.com`, name: id })))
    .onConflictDoNothing();
  gym = await insertGym(GYM_OWNER);
  await db.insert(dbSchema.gymMembers).values([
    { gymId: gym.id, userId: GYM_ADMIN, role: 'admin' },
    { gymId: gym.id, userId: GYM_EDITOR, role: 'editor' },
  ]);
  await db.insert(dbSchema.communityRoles).values([
    { userId: KILTER_LEADER, role: 'community_leader', boardType: 'kilter' },
    { userId: TENSION_LEADER, role: 'community_leader', boardType: 'tension' },
    { userId: GLOBAL_ADMIN, role: 'admin', boardType: null },
  ]);
  climberBoard = await insertBoard(CREATOR, gym.id);
  systemBoard = await insertBoard(SYSTEM_OWNER, gym.id);
});

describe('detachBoardFromGym — Remove from gym', () => {
  it('freezes the board, records the removal and holds the creator off re-linking', async () => {
    expect(await detach(gym.uuid, climberBoard.uuid, GYM_EDITOR)).toBe(true);

    const removed = await boardRow(climberBoard.id);
    expect(removed.gymId).toBeNull();
    expect(removed.syncFrozenAt).toBeInstanceOf(Date);
    expect(removed.deletedAt).toBeNull();
    expect(removed.ownerId).toBe(CREATOR);
    expect(await eventsFor(climberBoard.id)).toEqual([
      expect.objectContaining({
        gymId: gym.id,
        actorUserId: GYM_EDITOR,
        actorRole: 'gym_editor',
        action: 'removed_from_gym',
        details: { mutation: 'detachBoardFromGym' },
      }),
    ]);

    const relink = linkBoardToGym(climberBoard.uuid, gym.uuid, CREATOR);
    await expect(relink).rejects.toThrow("This gym's staff took this board off their listing. Ask them to re-list it.");
    await expect(relink).rejects.toSatisfy(
      (error: unknown) => error instanceof GraphQLError && error.extensions.code === 'BOARD_REMOVED_BY_GYM',
    );
    expect((await boardRow(climberBoard.id)).gymId).toBeNull();
  });

  it.each([GYM_OWNER, GYM_ADMIN, GYM_EDITOR, KILTER_LEADER])(
    'refuses %s removing a synced board, which is deleted instead',
    async (userId) => {
      // Removed, it would be a frozen pin with no gym that the stray list hides
      // and only a global admin could delete.
      const removal = detach(gym.uuid, systemBoard.uuid, userId);
      await expect(removal).rejects.toThrow(
        'This board comes from public board data. Delete it instead, or report it.',
      );
      await expect(removal).rejects.toSatisfy(
        (error: unknown) => error instanceof GraphQLError && error.extensions.code === 'SYSTEM_BOARD_DELETE_INSTEAD',
      );
      const untouched = await boardRow(systemBoard.id);
      expect(untouched.gymId).toBe(gym.id);
      expect(untouched.syncFrozenAt).toBeNull();
      expect(await eventsFor(systemBoard.id)).toEqual([]);
    },
  );

  it('lets a global admin remove a synced board, frozen so the hourly location sync cannot put it back', async () => {
    // The sync's board upsert skips a frozen row entirely, gym link included:
    // packages/location-sync/src/upsert.freeze.integration.test.ts proves that half.
    await detach(gym.uuid, systemBoard.uuid, GLOBAL_ADMIN);
    const removed = await boardRow(systemBoard.id);
    expect(removed.gymId).toBeNull();
    expect(removed.syncFrozenAt).toBeInstanceOf(Date);
    expect(await eventsFor(systemBoard.id)).toEqual([
      expect.objectContaining({ actorUserId: GLOBAL_ADMIN, actorRole: 'global_admin', action: 'removed_from_gym' }),
    ]);
  });

  it('places no hold when the creator removes their own board', async () => {
    await db.insert(dbSchema.gymMembers).values({ gymId: gym.id, userId: CREATOR, role: 'editor' });
    await detach(gym.uuid, climberBoard.uuid, CREATOR);
    expect(await eventsFor(climberBoard.id)).toEqual([
      expect.objectContaining({ actorRole: 'board_owner', action: 'removed_from_gym' }),
    ]);
    await expect(linkBoardToGym(climberBoard.uuid, gym.uuid, CREATOR)).resolves.toBe(true);
    expect((await boardRow(climberBoard.id)).gymId).toBe(gym.id);
  });

  it('records the community role a covering leader used, and refuses one that does not cover the gym', async () => {
    await expect(detach(gym.uuid, climberBoard.uuid, TENSION_LEADER)).rejects.toThrow(
      /Not authorized to edit this gym/,
    );
    await detach(gym.uuid, climberBoard.uuid, KILTER_LEADER);
    expect(await eventsFor(climberBoard.id)).toEqual([
      expect.objectContaining({ actorUserId: KILTER_LEADER, actorRole: 'community_leader' }),
    ]);
  });
});

describe('putting a removed board back', () => {
  it('lets staff re-list a removed board by uuid, which lifts the hold', async () => {
    await detach(gym.uuid, climberBoard.uuid, GYM_EDITOR);
    // Not offered as a stray (the climber's board never was one), yet re-listable.
    expect(await attach(gym.uuid, climberBoard.uuid, GYM_ADMIN)).toBe(true);
    expect((await boardRow(climberBoard.id)).gymId).toBe(gym.id);
    expect((await eventsFor(climberBoard.id)).map((event) => [event.action, event.actorRole])).toEqual([
      ['removed_from_gym', 'gym_editor'],
      ['relinked', 'gym_admin'],
    ]);

    // The hold is gone: the creator can take it off and put it back themselves.
    await linkBoardToGym(climberBoard.uuid, null, CREATOR);
    await expect(linkBoardToGym(climberBoard.uuid, gym.uuid, CREATOR)).resolves.toBe(true);
  });

  it('does not offer a removed synced board under boards near your gym', async () => {
    const nearbyUnlinked = await insertBoard(SYSTEM_OWNER, null);
    await detach(gym.uuid, systemBoard.uuid, GLOBAL_ADMIN);

    const strays = (await strayBoardsForGym(gym.uuid, GYM_OWNER)).map((stray) => stray.uuid);
    expect(strays).toContain(nearbyUnlinked.uuid);
    expect(strays).not.toContain(systemBoard.uuid);
  });

  it('will not pull a removed board off the gym its creator moved it to', async () => {
    await detach(gym.uuid, climberBoard.uuid, GYM_EDITOR);
    const otherGym = await insertGym(OUTSIDER, 'Other gym');
    await linkBoardToGym(climberBoard.uuid, otherGym.uuid, CREATOR);

    await expect(attach(gym.uuid, climberBoard.uuid, GYM_ADMIN)).rejects.toThrow(/not a stray candidate/);
    expect((await boardRow(climberBoard.id)).gymId).toBe(otherGym.id);
  });

  it('will not re-list a removed board whose location its creator has hidden since', async () => {
    await detach(gym.uuid, climberBoard.uuid, GYM_EDITOR);
    await db.update(dbSchema.userBoards).set({ hideLocation: true }).where(eq(dbSchema.userBoards.id, climberBoard.id));

    await expect(attach(gym.uuid, climberBoard.uuid, GYM_ADMIN)).rejects.toThrow(/not a stray candidate/);
    expect((await boardRow(climberBoard.id)).gymId).toBeNull();
  });

  it('will not re-list a removed board its creator has linked and unlinked since', async () => {
    await detach(gym.uuid, climberBoard.uuid, GYM_EDITOR);
    const otherGym = await insertGym(OUTSIDER, 'Other gym');
    await linkBoardToGym(climberBoard.uuid, otherGym.uuid, CREATOR);
    await linkBoardToGym(climberBoard.uuid, null, CREATOR);
    // The creator's own link changes are on the record, and place no hold.
    expect((await eventsFor(climberBoard.id)).map((event) => [event.action, event.actorRole, event.gymId])).toEqual([
      ['removed_from_gym', 'gym_editor', gym.id],
      ['relinked', 'board_owner', otherGym.id],
      ['removed_from_gym', 'board_owner', otherGym.id],
    ]);

    await expect(attach(gym.uuid, climberBoard.uuid, GYM_ADMIN)).rejects.toThrow(/not a stray candidate/);
    expect((await boardRow(climberBoard.id)).gymId).toBeNull();
    // Still held off this gym, and free to go back to the other one.
    await expect(linkBoardToGym(climberBoard.uuid, gym.uuid, CREATOR)).rejects.toThrow(/Ask them to re-list it/);
    await expect(linkBoardToGym(climberBoard.uuid, otherGym.uuid, CREATOR)).resolves.toBe(true);
  });

  it('lets a gym admin link their own removed board back through the staff path, recorded as a relink', async () => {
    const adminBoard = await insertBoard(GYM_ADMIN, gym.id);
    await detach(gym.uuid, adminBoard.uuid, GYM_OWNER);
    await expect(linkBoardToGym(adminBoard.uuid, gym.uuid, GYM_ADMIN)).resolves.toBe(true);
    expect((await eventsFor(adminBoard.id)).map((event) => [event.action, event.actorRole])).toEqual([
      ['removed_from_gym', 'gym_owner'],
      ['relinked', 'gym_admin'],
    ]);
  });
});

describe('UserBoard.canDelete and canRemoveFromGym', () => {
  type Flags = { canDelete: boolean; canRemoveFromGym: boolean };
  const flags = (canDelete: boolean, canRemoveFromGym: boolean): Flags => ({ canDelete, canRemoveFromGym });

  // [viewer, climber's board, synced board]
  const cases: Array<[string, Flags, Flags]> = [
    [CREATOR, flags(true, true), flags(false, false)],
    // A synced board is deleted, never removed: only a global admin removes one.
    [GYM_OWNER, flags(false, true), flags(true, false)],
    [GYM_ADMIN, flags(false, true), flags(true, false)],
    [GYM_EDITOR, flags(false, true), flags(false, false)],
    [KILTER_LEADER, flags(false, true), flags(false, false)],
    [TENSION_LEADER, flags(false, false), flags(false, false)],
    [GLOBAL_ADMIN, flags(true, true), flags(true, true)],
    [OUTSIDER, flags(false, false), flags(false, false)],
  ];

  it.each(cases)('single-board read for %s', async (viewer, onClimberBoard, onSystemBoard) => {
    const climber = await socialBoardQueries.board(null, { boardUuid: climberBoard.uuid }, authCtx(viewer));
    const system = await socialBoardQueries.board(null, { boardUuid: systemBoard.uuid }, authCtx(viewer));
    expect(climber).toMatchObject(onClimberBoard);
    expect(system).toMatchObject(onSystemBoard);
  });

  it.each(cases)('gym board list for %s', async (viewer, onClimberBoard, onSystemBoard) => {
    const boards = await socialBoardQueries.gymBoards(null, { gymUuid: gym.uuid }, authCtx(viewer));
    expect(boards.find((board) => board.uuid === climberBoard.uuid)).toMatchObject(onClimberBoard);
    expect(boards.find((board) => board.uuid === systemBoard.uuid)).toMatchObject(onSystemBoard);
  });

  it('is false for a signed-out viewer', async () => {
    const single = await socialBoardQueries.board(null, { boardUuid: systemBoard.uuid }, anonCtx());
    expect(single).toMatchObject(flags(false, false));
    const listed = await socialBoardQueries.gymBoards(null, { gymUuid: gym.uuid }, anonCtx());
    expect(listed.every((board) => !board.canDelete && !board.canRemoveFromGym)).toBe(true);
  });

  it('offers no removal for a board with no gym', async () => {
    await linkBoardToGym(climberBoard.uuid, null, CREATOR);
    const board = await socialBoardQueries.board(null, { boardUuid: climberBoard.uuid }, authCtx(CREATOR));
    expect(board).toMatchObject(flags(true, false));
  });

  it('counts a scoped leader only at a gym with a board of their type', async () => {
    const tensionGym = await insertGym(OUTSIDER, 'Tension only');
    const tensionBoard = await insertBoard(CREATOR, tensionGym.id, 'tension');
    const asTensionLeader = await socialBoardQueries.board(
      null,
      { boardUuid: tensionBoard.uuid },
      authCtx(TENSION_LEADER),
    );
    expect(asTensionLeader).toMatchObject(flags(false, true));
    const asKilterLeader = await socialBoardQueries.board(
      null,
      { boardUuid: tensionBoard.uuid },
      authCtx(KILTER_LEADER),
    );
    expect(asKilterLeader).toMatchObject(flags(false, false));
  });
});

describe('the re-link hold under a concurrent removal', () => {
  it("refuses the creator's link when a staff removal commits between the gate and the write", async () => {
    // The creator re-saves their board's gym while a gym editor removes it. The
    // gate reads the board before the removal commits; the write must not.
    const holdingPid = createValueBarrier<number>();
    const releaseRemoval = createBarrier();
    const removal = db.transaction(async (tx) => {
      const [backend] = rowsFromResult<{ pid: number }>(await tx.execute(sql`SELECT pg_backend_pid() AS pid`));
      await tx
        .update(dbSchema.userBoards)
        .set({ gymId: null, syncFrozenAt: new Date() })
        .where(eq(dbSchema.userBoards.id, climberBoard.id));
      await tx.insert(dbSchema.boardModerationEvents).values({
        boardId: climberBoard.id,
        gymId: gym.id,
        actorUserId: GYM_EDITOR,
        actorRole: 'gym_editor',
        action: 'removed_from_gym',
        details: { mutation: 'detachBoardFromGym' },
      });
      holdingPid.release(backend.pid);
      await releaseRemoval.promise;
    });
    handleLater(removal);
    const blockerPid = await holdingPid.promise;
    const relink = linkBoardToGym(climberBoard.uuid, gym.uuid, CREATOR);
    handleLater(relink);
    try {
      await vi.waitFor(
        async () => {
          const [activity] = rowsFromResult<{ blocked: boolean }>(
            await db.execute(sql`
              SELECT EXISTS (
                SELECT 1 FROM pg_stat_activity
                WHERE ${blockerPid} = ANY(pg_blocking_pids(pid)) AND wait_event_type = 'Lock'
              ) AS blocked
            `),
          );
          expect(activity.blocked).toBe(true);
        },
        { timeout: 5000, interval: 20 },
      );
    } finally {
      releaseRemoval.release();
      await removal;
    }
    await expect(relink).rejects.toThrow("This gym's staff took this board off their listing. Ask them to re-list it.");
    expect((await boardRow(climberBoard.id)).gymId).toBeNull();
    expect((await eventsFor(climberBoard.id)).map((event) => event.action)).toEqual(['removed_from_gym']);
  });
});

describe('clearing the sync freeze on a removed board', () => {
  it('is refused while the latest removal holds it off a gym', async () => {
    // Staff can no longer remove a synced board; a global admin still can, and
    // older rows exist. The freeze is what keeps the sync from relinking it.
    await detach(gym.uuid, systemBoard.uuid, GLOBAL_ADMIN);
    const frozen = await boardRow(systemBoard.id);
    const unfreeze = socialLocationSyncFreezeMutations.clearLocationSyncFreeze(
      null,
      {
        input: {
          entityType: 'BOARD',
          entityUuid: systemBoard.uuid,
          expectedSyncFrozenAt: frozen.syncFrozenAt!.toISOString(),
          reason: 'The wall is back on the gym map upstream',
        },
      },
      authCtx(GLOBAL_ADMIN),
    );
    await expect(unfreeze).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof GraphQLError && error.extensions.code === 'LOCATION_SYNC_BOARD_REMOVED_BY_GYM',
    );
    expect((await boardRow(systemBoard.id)).syncFrozenAt).toEqual(frozen.syncFrozenAt);
  });
});

describe('staff edits on the record', () => {
  it("records a gym admin's edit of a climber's board with the fields that changed", async () => {
    const before = await boardRow(climberBoard.id);
    await socialBoardMutations.updateBoard(
      null,
      // The edit screen echoes unchanged fields back: only `name` changed.
      { input: { boardUuid: climberBoard.uuid, name: 'Renamed by staff', angle: before.angle } },
      authCtx(GYM_ADMIN),
    );
    expect(await eventsFor(climberBoard.id)).toEqual([
      expect.objectContaining({
        gymId: gym.id,
        actorUserId: GYM_ADMIN,
        actorRole: 'gym_admin',
        action: 'edited_by_staff',
        details: { mutation: 'updateBoard', fields: ['name'] },
      }),
    ]);
  });

  it('records nothing for the creator, or for a staff save that changes nothing', async () => {
    const before = await boardRow(climberBoard.id);
    await socialBoardMutations.updateBoard(
      null,
      { input: { boardUuid: climberBoard.uuid, name: 'My own rename' } },
      authCtx(CREATOR),
    );
    await socialBoardMutations.updateBoard(
      null,
      { input: { boardUuid: climberBoard.uuid, name: 'My own rename', angle: before.angle } },
      authCtx(GYM_ADMIN),
    );
    expect(await eventsFor(climberBoard.id)).toEqual([]);
  });

  it('records an admin edit as the global admin role', async () => {
    await updateBoardRecord({ boardUuid: systemBoard.uuid, name: 'Fixed by admin' }, authCtx(GLOBAL_ADMIN), 'admin');
    expect(await eventsFor(systemBoard.id)).toEqual([
      expect.objectContaining({
        actorRole: 'global_admin',
        action: 'edited_by_staff',
        details: { mutation: 'adminUpdateBoard', fields: ['name'] },
      }),
    ]);
  });
});

describe('Gym.listingState', () => {
  const listingStateOf = async (gymId: number) => {
    const [row] = await db.select().from(dbSchema.gyms).where(eq(dbSchema.gyms.id, gymId));
    return (await enrichGym(row)).listingState;
  };

  it('reads a synced gym as not claimed yet', async () => {
    const synced = await insertGym(SYSTEM_OWNER, 'Synced gym');
    expect(await listingStateOf(synced.id)).toBe('UNCLAIMED');
  });

  it('reads a gym a climber made while setting up a board as climber-listed', async () => {
    expect(await listingStateOf(gym.id)).toBe('CLIMBER_LISTED');
  });

  it('reads a gym whose owner holds an approved claim as run by the gym', async () => {
    await db
      .insert(dbSchema.gymClaims)
      .values({ gymId: gym.id, claimantUserId: GYM_OWNER, method: 'admin', status: 'approved' });
    expect(await listingStateOf(gym.id)).toBe('RUN_BY_GYM');
  });

  it('ignores an approved claim held by someone who no longer owns the gym', async () => {
    await db
      .insert(dbSchema.gymClaims)
      .values({ gymId: gym.id, claimantUserId: OUTSIDER, method: 'admin', status: 'approved' });
    await db
      .insert(dbSchema.gymClaims)
      .values({ gymId: gym.id, claimantUserId: GYM_OWNER, method: 'admin', status: 'pending' });
    expect(await listingStateOf(gym.id)).toBe('CLIMBER_LISTED');
  });

  it('reads a gym handed over by an admin as run by the gym', async () => {
    await db.insert(dbSchema.gymOwnerReassignments).values({
      gymUuid: gym.uuid,
      previousOwnerId: SYSTEM_OWNER,
      newOwnerId: GYM_OWNER,
      reason: 'Sold to the climbing club',
      performedBy: GLOBAL_ADMIN,
    });
    expect(await listingStateOf(gym.id)).toBe('RUN_BY_GYM');
  });

  it('is the same for a signed-out viewer', async () => {
    await db
      .insert(dbSchema.gymClaims)
      .values({ gymId: gym.id, claimantUserId: GYM_OWNER, method: 'admin', status: 'approved' });
    const [row] = await db.select().from(dbSchema.gyms).where(eq(dbSchema.gyms.id, gym.id));
    expect((await enrichGym(row, undefined)).listingState).toBe('RUN_BY_GYM');
    expect((await enrichGym(row, OUTSIDER)).listingState).toBe('RUN_BY_GYM');
  });

  it('maps owner and authority to the three states', () => {
    expect(gymListingState(SYSTEM_OWNER, true)).toBe('UNCLAIMED');
    expect(gymListingState(GYM_OWNER, false)).toBe('CLIMBER_LISTED');
    expect(gymListingState(GYM_OWNER, true)).toBe('RUN_BY_GYM');
  });
});
