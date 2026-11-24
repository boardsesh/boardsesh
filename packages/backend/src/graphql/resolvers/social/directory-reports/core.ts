import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import type { BoardModerationActorRole } from '@boardsesh/db/schema';
import type { DirectoryReportResolverRole, GymListingState } from '@boardsesh/directory-moderation';
import { db } from '../../../../db/client';
import { SYSTEM_BOARD_OWNER_ID } from '../../board-presence/shared';
import { gymListingState } from '../gyms';
import { ownerHoldsClaimOrHandoverColumn } from '../gym-run-by-staff';
import type { ModerationExecutor } from '../board-moderation-events';

// ============================================
// Directory reports: shared reads
// ============================================
//
// The facts every part of the reports feature needs about a gym or a board:
// who runs a gym, who counts as its staff, and which role an action was taken
// in. docs/product/directory-reports.md describes the feature.

export type DirectoryExecutor = ModerationExecutor;

/** Statuses still waiting on someone (`@boardsesh/directory-moderation`'s OPEN_DIRECTORY_REPORT_STATUSES). */
export const WAITING_STATUSES = ['open', 'escalated'] as const satisfies readonly dbSchema.DirectoryReportStatusValue[];

export function isSystemOwner(ownerId: string): boolean {
  return ownerId === SYSTEM_BOARD_OWNER_ID;
}

export type GymFacts = {
  id: number;
  uuid: string;
  name: string;
  ownerId: string;
  isPublic: boolean;
  isListed: boolean;
  deletedAt: Date | null;
  mergedIntoGymId: number | null;
  listingState: GymListingState;
};

/** The gyms behind these ids, deleted ones included, with their listing state. */
export async function loadGymFacts(
  gymIds: readonly number[],
  executor: DirectoryExecutor = db,
): Promise<Map<number, GymFacts>> {
  const ids = [...new Set(gymIds)];
  if (ids.length === 0) return new Map();
  const rows = await executor
    .select({
      id: dbSchema.gyms.id,
      uuid: dbSchema.gyms.uuid,
      name: dbSchema.gyms.name,
      ownerId: dbSchema.gyms.ownerId,
      isPublic: dbSchema.gyms.isPublic,
      isListed: dbSchema.gyms.isListed,
      deletedAt: dbSchema.gyms.deletedAt,
      mergedIntoGymId: dbSchema.gyms.mergedIntoGymId,
      holdsClaimOrHandover: ownerHoldsClaimOrHandoverColumn(),
    })
    .from(dbSchema.gyms)
    .where(inArray(dbSchema.gyms.id, ids));
  return new Map(
    rows.map(({ holdsClaimOrHandover, ...gym }) => [
      gym.id,
      { ...gym, listingState: gymListingState(gym.ownerId, holdsClaimOrHandover === true) },
    ]),
  );
}

export type BoardFacts = {
  id: number;
  uuid: string;
  name: string;
  boardType: string;
  ownerId: string;
  gymId: number | null;
  deletedAt: Date | null;
  mergedIntoBoardUuid: string | null;
};

const BOARD_FACT_COLUMNS = {
  id: dbSchema.userBoards.id,
  uuid: dbSchema.userBoards.uuid,
  name: dbSchema.userBoards.name,
  boardType: dbSchema.userBoards.boardType,
  ownerId: dbSchema.userBoards.ownerId,
  gymId: dbSchema.userBoards.gymId,
  deletedAt: dbSchema.userBoards.deletedAt,
  mergedIntoBoardUuid: dbSchema.userBoards.mergedIntoBoardUuid,
};

/** The boards behind these ids, deleted ones included. */
export async function loadBoardFacts(
  boardIds: readonly number[],
  executor: DirectoryExecutor = db,
): Promise<Map<number, BoardFacts>> {
  const ids = [...new Set(boardIds)];
  if (ids.length === 0) return new Map();
  const rows = await executor
    .select(BOARD_FACT_COLUMNS)
    .from(dbSchema.userBoards)
    .where(inArray(dbSchema.userBoards.id, ids));
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * One board's facts under a row lock, in the caller's transaction: a write to
 * the board in flight (a delete, a removal, a move) commits first, and the next
 * one waits for the caller to finish. A share lock by default; `no key update`
 * when the caller may write the board itself (a suggested setup), so it never
 * has to upgrade the lock and two such callers on one board take turns. It
 * changes no key, so inserts that only reference the board don't wait on it.
 */
export async function lockBoardFacts(
  boardId: number,
  executor: DirectoryExecutor,
  strength: 'share' | 'no key update' = 'share',
): Promise<BoardFacts | undefined> {
  const [row] = await executor
    .select(BOARD_FACT_COLUMNS)
    .from(dbSchema.userBoards)
    .where(eq(dbSchema.userBoards.id, boardId))
    .limit(1)
    .for(strength);
  return row;
}

export async function loadBoardFactsByUuid(
  boardUuid: string,
  executor: DirectoryExecutor = db,
): Promise<BoardFacts | undefined> {
  const [row] = await executor
    .select(BOARD_FACT_COLUMNS)
    .from(dbSchema.userBoards)
    .where(eq(dbSchema.userBoards.uuid, boardUuid))
    .limit(1);
  return row;
}

/**
 * A gym's staff, as reports are routed: its owner (unless that is the SYSTEM
 * import account) and its admin members. Editors are not routed to; they may
 * read the reports (`viewerGymStaffing`). Nobody for a deleted gym.
 */
export async function gymManagerIds(gymId: number, executor: DirectoryExecutor = db): Promise<string[]> {
  const [gym] = await executor
    .select({ ownerId: dbSchema.gyms.ownerId })
    .from(dbSchema.gyms)
    .where(and(eq(dbSchema.gyms.id, gymId), isNull(dbSchema.gyms.deletedAt)))
    .limit(1);
  if (!gym) return [];
  const admins = await executor
    .select({ userId: dbSchema.gymMembers.userId })
    .from(dbSchema.gymMembers)
    .where(and(eq(dbSchema.gymMembers.gymId, gymId), eq(dbSchema.gymMembers.role, 'admin')));
  const ids = new Set(admins.map((admin) => admin.userId));
  if (!isSystemOwner(gym.ownerId)) ids.add(gym.ownerId);
  return [...ids];
}

export type ViewerGymStaffing = {
  /** Live gyms the viewer owns or administers: they are routed to and may close reports. */
  managed: Set<number>;
  /** Live gyms the viewer owns, administers or edits: they may read the reports routed to staff. */
  staffed: Set<number>;
};

/** Where the viewer is gym staff. With `gymIds`, only among those gyms. */
export async function viewerGymStaffing(
  viewerId: string,
  executor: DirectoryExecutor = db,
  gymIds?: readonly number[],
): Promise<ViewerGymStaffing> {
  const managed = new Set<number>();
  const staffed = new Set<number>();
  if (gymIds && gymIds.length === 0) return { managed, staffed };
  const scope = gymIds ? inArray(dbSchema.gyms.id, [...new Set(gymIds)]) : undefined;
  const [owned, memberships] = await Promise.all([
    executor
      .select({ id: dbSchema.gyms.id })
      .from(dbSchema.gyms)
      .where(and(eq(dbSchema.gyms.ownerId, viewerId), isNull(dbSchema.gyms.deletedAt), scope)),
    executor
      .select({ id: dbSchema.gyms.id, role: dbSchema.gymMembers.role })
      .from(dbSchema.gymMembers)
      .innerJoin(dbSchema.gyms, eq(dbSchema.gyms.id, dbSchema.gymMembers.gymId))
      .where(
        and(
          eq(dbSchema.gymMembers.userId, viewerId),
          or(eq(dbSchema.gymMembers.role, 'admin'), eq(dbSchema.gymMembers.role, 'editor')),
          isNull(dbSchema.gyms.deletedAt),
          scope,
        ),
      ),
  ]);
  for (const { id } of owned) {
    managed.add(id);
    staffed.add(id);
  }
  for (const { id, role } of memberships) {
    staffed.add(id);
    if (role === 'admin') managed.add(id);
  }
  return { managed, staffed };
}

/** How a staff action's role reads to the person who closed a report with it. */
export function resolverRoleForActor(actorRole: BoardModerationActorRole): DirectoryReportResolverRole {
  if (actorRole === 'board_owner') return 'creator';
  // A climber's suggested setup closed it: not an admin's call.
  if (actorRole === 'climber') return 'climber';
  if (actorRole === 'gym_owner' || actorRole === 'gym_admin' || actorRole === 'gym_editor') return 'gym_staff';
  return 'admin';
}

/** How a staff action's role reads in analytics: `Board Removed From Gym` / `Board Deleted` {by}. */
export function analyticsActorFor(
  actorRole: BoardModerationActorRole,
): 'creator' | 'gym_staff' | 'moderator' | 'admin' {
  if (actorRole === 'board_owner') return 'creator';
  if (actorRole === 'gym_owner' || actorRole === 'gym_admin' || actorRole === 'gym_editor') return 'gym_staff';
  if (actorRole === 'global_admin') return 'admin';
  return 'moderator';
}
