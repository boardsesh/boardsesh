import { and, asc, desc, eq, inArray, isNull, or, type SQL } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import {
  classifyWallMatch,
  compareWallCandidates,
  diffWallSetIds,
  type WallCandidateSource,
  type WallMatchKind,
  type WallSetup,
} from '@boardsesh/board-config';
import { lockGymWallWrites, type BoardSerialWriteCommandDb } from '@boardsesh/db/queries';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import { resourceAccessCondition } from '../../../services/privacy';
import { logger } from '../../../utils/logger';
import { listableSprayWallCondition } from '../board/spray-wall-listing';
import { collectMergedTwinGymIds } from './gym-stray-boards';
import { findGymsWithin, PROXIMITY_MATCH_RADIUS_METERS } from './gym-matching';

// ============================================
// Existing-wall check (#8151)
// ============================================
//
// "Is the wall this climber is adding already listed?" Shared by the
// `existingWallCandidates` query (board-wall-candidates.ts), which shows the
// walls, and createBoard's opt-in recheck, which refuses a create that would
// add a second copy of one. Both read the same walls with the same
// viewer-scoped predicate, so a create is only ever refused over a wall the
// climber could have been shown. A private wall never blocks and never leaks.
//
// Deliberately free of any import from ./boards: boards.ts imports this file.

type GymRow = typeof dbSchema.gyms.$inferSelect;
type BoardRow = typeof dbSchema.userBoards.$inferSelect;
type WallReadExecutor = Pick<typeof db, 'select'>;

/** How far from the chosen gym (or the typed location) other listings are searched. */
export const WALL_SEARCH_RADIUS_METERS = PROXIMITY_MATCH_RADIUS_METERS;

/** Most nearby listings searched besides the chosen gym and its merged listings. */
export const MAX_NEARBY_WALL_GYMS = 10;

/**
 * Most board rows one check reads. A gym with more same-type walls than this is
 * not a real place; the cap only stops a pathological listing from turning the
 * check into a scan.
 */
const MAX_WALL_ROWS = 100;

/** Most walls a BOARD_EXISTING_WALLS error names. Matches the acknowledged-uuid cap. */
const MAX_ERROR_CANDIDATES = 40;

export type ExistingWallCheckMode = 'REJECT_IF_FOUND' | 'CONFIRMED_SEPARATE';

/** A gym whose walls are searched. */
export type WallScopeGym = {
  id: number;
  /** The name shown on its walls. A merged listing shows the gym it merged into. */
  name: string;
  source: WallCandidateSource;
  /** Metres from the chosen gym (or typed location); null for the chosen gym and merged listings. */
  distanceMeters: number | null;
  /** False for a merged listing: soft-deleted, so nobody adds a board to it and it needs no lock. */
  isLive: boolean;
};

/** Where the search is centred: the gym the board lands on, or a typed location when a gym is being minted. */
export type WallSearchAnchor =
  | { kind: 'gym'; gym: Pick<GymRow, 'id' | 'name' | 'latitude' | 'longitude'> }
  | { kind: 'point'; latitude: number; longitude: number };

/** The gyms one check searches, and the point "nearby" was measured from. */
export type WallScope = {
  gyms: WallScopeGym[];
  /** The chosen gym's id, whose walls rank (and are read) first; null on the mint path. */
  selectedGymId: number | null;
  /** Null when there is nothing to measure "nearby" from (a gym without coordinates). */
  center: { latitude: number; longitude: number } | null;
};

export type WallCandidate = {
  board: BoardRow;
  matchKind: WallMatchKind | null;
  missingSetIds: number[];
  extraSetIds: number[];
  source: WallCandidateSource;
  gymName: string;
  gymDistanceMeters: number | null;
};

/** Public, listed gyms within the search radius that aren't in the scope yet, nearest first. */
async function nearbyScopeGyms(
  center: { latitude: number; longitude: number },
  excludeGymIds: ReadonlySet<number>,
  limit: number,
  executor?: WallReadExecutor,
): Promise<WallScopeGym[]> {
  const nearby = await findGymsWithin({
    latitude: center.latitude,
    longitude: center.longitude,
    radiusMeters: WALL_SEARCH_RADIUS_METERS,
    publicListedOnly: true,
    executor,
  });
  return nearby
    .filter((gym) => !excludeGymIds.has(gym.id))
    .slice(0, limit)
    .map((gym) => ({
      id: gym.id,
      name: gym.name,
      source: 'NEARBY_LISTING' as const,
      distanceMeters: gym.distanceMeters,
      isLive: true,
    }));
}

/**
 * The gyms whose walls count: the chosen gym, the listings an admin merged into
 * it (boards can be left behind on a merged twin), and public, listed gyms
 * within 150 m, nearest first and at most ten. A private gym nearby is never
 * searched, whoever owns it. A gym without coordinates has no "nearby".
 *
 * Reads on the pool. createBoard calls it BEFORE opening its transaction: a
 * transaction that waited on a second pool connection would hold its own while
 * it waited, and a handful of concurrent creates could take every connection.
 */
export async function collectWallScope(anchor: WallSearchAnchor): Promise<WallScope> {
  const gyms: WallScopeGym[] = [];
  let center: WallScope['center'] = null;
  let selectedGymId: number | null = null;

  if (anchor.kind === 'gym') {
    const { gym } = anchor;
    selectedGymId = gym.id;
    gyms.push({ id: gym.id, name: gym.name, source: 'SELECTED_GYM', distanceMeters: null, isLive: true });
    // A merged twin is a soft-deleted old listing of this same gym. Its walls
    // are shown under the gym's current name, never the old row's own name,
    // which nobody vetted for public display after the merge.
    for (const twinGymId of await collectMergedTwinGymIds(gym.id)) {
      gyms.push({ id: twinGymId, name: gym.name, source: 'MERGED_LISTING', distanceMeters: null, isLive: false });
    }
    if (gym.latitude != null && gym.longitude != null) {
      center = { latitude: gym.latitude, longitude: gym.longitude };
    }
  } else {
    center = { latitude: anchor.latitude, longitude: anchor.longitude };
  }

  if (center) {
    gyms.push(...(await nearbyScopeGyms(center, new Set(gyms.map((gym) => gym.id)), MAX_NEARBY_WALL_GYMS)));
  }
  return { gyms, selectedGymId, center };
}

/**
 * Which walls a viewer may be shown or refused over. Their own boards, and
 * publicly listed boards that pass the resource-privacy override: the
 * `gymBoardListingConditions` rule for a non-editor, plus the viewer's own.
 * Gym staff get no wider view here. A staff member adding a board is a
 * climber like any other, and the check must never block on a wall a stranger
 * would not see.
 */
function visibleWallCondition(viewerId: string | undefined): SQL {
  const publiclyListed = and(
    eq(dbSchema.userBoards.isPublic, true),
    eq(dbSchema.userBoards.isUnlisted, false),
    resourceAccessCondition('board', dbSchema.userBoards.uuid, viewerId, { allowUnlistedLink: false }),
  )!;
  return viewerId ? or(eq(dbSchema.userBoards.ownerId, viewerId), publiclyListed)! : publiclyListed;
}

/**
 * The walls of one board type on the scope gyms that the viewer can see,
 * classified against the draft (when there is one) and ranked best first.
 * `rowCapReached` is true when more rows existed than one check reads.
 */
export async function readWallCandidates(opts: {
  scope: WallScope;
  boardType: string;
  viewerId: string | undefined;
  draft: WallSetup | null;
  /**
   * Read only walls on the draft's layout and size. The recheck sets it: other
   * layouts never block, so they must not spend the row cap.
   */
  draftLayoutOnly?: boolean;
  executor?: WallReadExecutor;
}): Promise<{ candidates: WallCandidate[]; rowCapReached: boolean }> {
  const { scope, boardType, viewerId, draft, draftLayoutOnly = false, executor = db } = opts;
  if (scope.gyms.length === 0) return { candidates: [], rowCapReached: false };

  const scopeById = new Map(scope.gyms.map((scopeGym) => [scopeGym.id, scopeGym]));
  const mergedGymIds = scope.gyms.filter((scopeGym) => scopeGym.source === 'MERGED_LISTING').map((gym) => gym.id);
  const sameLayout = draft
    ? and(eq(dbSchema.userBoards.layoutId, draft.layoutId), eq(dbSchema.userBoards.sizeId, draft.sizeId))!
    : undefined;
  const rows = await executor
    .select()
    .from(dbSchema.userBoards)
    .where(
      and(
        inArray(dbSchema.userBoards.gymId, [...scopeById.keys()]),
        eq(dbSchema.userBoards.boardType, boardType),
        isNull(dbSchema.userBoards.deletedAt),
        draftLayoutOnly ? sameLayout : undefined,
        visibleWallCondition(viewerId),
        // Spray walls have their own setup and never reach here by type; kept
        // so this read can never list an unpublished one if that changes.
        listableSprayWallCondition(viewerId),
      ),
    )
    // The row cap must never push the chosen gym's own walls out for a busy
    // neighbour's: the chosen gym first, then its merged listings, then the
    // draft's layout, then oldest. The final order is compareWallCandidates'.
    .orderBy(
      ...[
        scope.selectedGymId != null ? desc(eq(dbSchema.userBoards.gymId, scope.selectedGymId)) : undefined,
        mergedGymIds.length > 0 ? desc(inArray(dbSchema.userBoards.gymId, mergedGymIds)) : undefined,
        sameLayout ? desc(sameLayout) : undefined,
        asc(dbSchema.userBoards.createdAt),
        asc(dbSchema.userBoards.uuid),
      ].filter((ordering): ordering is SQL => ordering != null),
    )
    .limit(MAX_WALL_ROWS + 1);

  const rowCapReached = rows.length > MAX_WALL_ROWS;
  const candidates = rows.slice(0, MAX_WALL_ROWS).flatMap((board): WallCandidate[] => {
    const scopeGym = board.gymId == null ? undefined : scopeById.get(board.gymId);
    if (!scopeGym) return [];
    const wallSetup: WallSetup = {
      boardType: board.boardType,
      layoutId: board.layoutId,
      sizeId: board.sizeId,
      setIds: board.setIds,
    };
    const setDifference = draft ? diffWallSetIds(draft, wallSetup) : { missingSetIds: [], extraSetIds: [] };
    return [
      {
        board,
        matchKind: draft ? classifyWallMatch(draft, wallSetup) : null,
        missingSetIds: setDifference.missingSetIds,
        extraSetIds: setDifference.extraSetIds,
        source: scopeGym.source,
        gymName: scopeGym.name,
        gymDistanceMeters: scopeGym.distanceMeters,
      },
    ];
  });

  candidates.sort((first, second) =>
    compareWallCandidates(
      { ...first, createdAt: first.board.createdAt, uuid: first.board.uuid },
      { ...second, createdAt: second.board.createdAt, uuid: second.board.uuid },
    ),
  );
  return { candidates, rowCapReached };
}

/** A wall the draft could be a copy of: same layout and size. Another layout or size is advisory only. */
function isComparableWall(candidate: WallCandidate): boolean {
  return candidate.matchKind === 'EXACT' || candidate.matchKind === 'SETS_DIFFER';
}

/**
 * The walls that stop a create, per the mode:
 * - REJECT_IF_FOUND: every same-layout wall, sets equal or not.
 * - CONFIRMED_SEPARATE with acknowledged walls: an EXACT wall the climber was
 *   not shown. Walls they saw and called different no longer block.
 * - CONFIRMED_SEPARATE with an empty list, or one naming none of the walls
 *   found: honoured only when there is no same-layout wall at all. Otherwise a client whose lookup failed (or a
 *   script) could send the confirmation blind and skip the check entirely.
 */
export function blockingWallCandidates(
  candidates: readonly WallCandidate[],
  mode: ExistingWallCheckMode,
  acknowledgedWallUuids: readonly string[],
): WallCandidate[] {
  const comparable = candidates.filter(isComparableWall);
  if (mode === 'REJECT_IF_FOUND') return comparable;
  // Only an acknowledgement of a wall the server also found counts. A list of
  // uuids that name nothing here is the same as an empty list, or one junk uuid
  // would get round the empty-list rule.
  const comparableUuids = new Set(comparable.map((candidate) => candidate.board.uuid));
  const acknowledged = new Set(acknowledgedWallUuids.filter((wallUuid) => comparableUuids.has(wallUuid)));
  if (acknowledged.size === 0) return comparable;
  return comparable.filter((candidate) => candidate.matchKind === 'EXACT' && !acknowledged.has(candidate.board.uuid));
}

/**
 * The refusal. Names each wall by uuid and match kind only: an error's
 * extensions are a read channel, so no names, owners or places travel here.
 * The client refetches `existingWallCandidates` to show them, which applies
 * the full read rules.
 */
export function existingWallsError(blocking: readonly WallCandidate[]): GraphQLError {
  return new GraphQLError('This board may already be listed here', {
    extensions: {
      code: 'BOARD_EXISTING_WALLS',
      candidates: blocking
        .slice(0, MAX_ERROR_CANDIDATES)
        .map((candidate) => ({ boardUuid: candidate.board.uuid, matchKind: candidate.matchKind })),
    },
  });
}

/**
 * createBoard's recheck, against a scope `collectWallScope` built before the
 * caller's transaction. With `transaction` (the authoritative run inside the
 * insert's transaction) it first takes the gym-wall locks on the scope's live
 * gyms, then reads only on that transaction: never on the pool, so a create
 * holds one connection, not two. Without it (the early run before the link
 * gate) it reads on the pool and takes no lock.
 *
 * The locks come first in the transaction and before the board-serial lock.
 * With them held, two creates of the same wall at once serialize: the second
 * reads after the first commits and sees its board. After the locks it reads
 * the nearest public listings again (and locks any new ones), so a gym another
 * create minted and committed while this one waited is searched too.
 */
export async function assertNoExistingWalls(opts: {
  scope: WallScope;
  draft: WallSetup;
  viewerId: string;
  mode: ExistingWallCheckMode;
  acknowledgedWallUuids: readonly string[];
  transaction?: BoardSerialWriteCommandDb & WallReadExecutor;
}): Promise<void> {
  const { draft, viewerId, mode, acknowledgedWallUuids, transaction } = opts;
  let { scope } = opts;
  if (transaction) {
    const lockedGymIds = new Set<number>();
    const lockLiveGyms = async (gyms: readonly WallScopeGym[]) => {
      const newGymIds = gyms
        .filter((scopeGym) => scopeGym.isLive && !lockedGymIds.has(scopeGym.id))
        .map((scopeGym) => scopeGym.id);
      await lockGymWallWrites(transaction, newGymIds);
      for (const gymId of newGymIds) lockedGymIds.add(gymId);
    };
    await lockLiveGyms(scope.gyms);
    if (scope.center) {
      // Recompute the nearest public listings now that the locks are held: a
      // gym another create minted and committed while this one waited may be
      // nearer than ones in the first read, and has to displace them even when
      // the first read was already at the cap. Lock any that are new before
      // reading their walls, so a create still in flight at one of them is
      // waited for too. These come after the first set, so they can be out of
      // ascending order; in that rare overlap Postgres detects the deadlock and
      // fails one create, which the climber retries. Never a silent duplicate.
      const fixedGyms = scope.gyms.filter((scopeGym) => scopeGym.source !== 'NEARBY_LISTING');
      const nearby = await nearbyScopeGyms(
        scope.center,
        new Set(fixedGyms.map((scopeGym) => scopeGym.id)),
        MAX_NEARBY_WALL_GYMS,
        transaction,
      );
      await lockLiveGyms(nearby);
      scope = { ...scope, gyms: [...fixedGyms, ...nearby] };
    }
  }
  const { candidates } = await readWallCandidates({
    scope,
    boardType: draft.boardType,
    viewerId,
    draft,
    draftLayoutOnly: true,
    executor: transaction,
  });
  const blocking = blockingWallCandidates(candidates, mode, acknowledgedWallUuids);
  if (blocking.length > 0) throw existingWallsError(blocking);

  // The one path that adds a board beside a wall the climber saw: leave a trail,
  // as the duplicate-config bypass does, so a script confirming every call shows
  // up. Only from the authoritative run, so one create logs once.
  if (transaction && mode === 'CONFIRMED_SEPARATE' && candidates.some(isComparableWall)) {
    logger.info('createBoard: existing walls acknowledged as separate', {
      userId: viewerId,
      boardType: draft.boardType,
      acknowledgedCount: acknowledgedWallUuids.length,
      comparableCount: candidates.filter(isComparableWall).length,
    });
  }
}
