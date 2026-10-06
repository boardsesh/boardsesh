import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LitUpHoldsMap } from '@boardsesh/shared-schema';
import {
  buildInitialFrames,
  buildLostHoldGhosts,
  findLostHoldIds,
  isGhostCovered,
  rankReplacementCandidates,
  type HoldCircle,
  type HoldPlacement,
  type LostHoldGhost,
  type ReplacementCandidate,
} from '@boardsesh/create-climb-react';
import type { GetClimbLostHoldsQueryVariables } from '@boardsesh/graphql/operations';
import { useClimbLostHolds } from '../../lib/graphql/hooks/use-climb-lost-holds';
import { getSprayWall, SPRAY_BOARD_NAME } from '../../lib/spray/spray-wall-registry';
import { mapCanonicalHoldsToPhoto, type SprayPhotoHold } from '../../lib/spray/spray-hold-geometry';
import { hapticSelection, hapticSuccess, hapticWarning } from '../../lib/haptics';
import type { BoardHoldTarget } from '../../lib/create-board-holds';
import type { CreateClimbBoard } from './use-create-climb-screen';

/**
 * What the editor shows about a climb's lost holds:
 *  - `none`: nothing is lost (or this is not a spray climb, or a fresh one);
 *  - `countOnly`: holds are lost, their positions are on the way (or there is
 *    no climb to ask about, such as a remix opened without its parent's uuid);
 *  - `ready`: positions known, ghosts drawn;
 *  - `noPositions`: the server answered but nothing it said can be drawn (a
 *    wall this viewer cannot see answers `[]`, a hold the homography drops, a
 *    wall registered without a homography). The count still shows;
 *  - `unavailable`: no signal or the read failed. The count still shows.
 */
export type LostHoldsStatus = 'none' | 'countOnly' | 'ready' | 'noPositions' | 'unavailable';

/** The ghost being replaced, and the live holds offered for it. */
export type LostHoldReplacement = {
  ghost: LostHoldGhost;
  candidates: readonly ReplacementCandidate[];
  /** The candidates' geometry in photo pixels, for the board to highlight. */
  candidateHolds: readonly HighlightedHold[];
};

/** A live hold the board highlights as a replacement. */
export type HighlightedHold = SprayPhotoHold & { isSuccessor: boolean };

export type LostHoldGhostsState = {
  status: LostHoldsStatus;
  /** Lost holds still unanswered: ghosts on screen, or the device's count while positions are unknown. */
  count: number;
  /** Ghosts not yet replaced, in photo pixels. */
  ghosts: readonly LostHoldGhost[];
  /** The same ghosts as tap targets, so a tap on one reaches `openGhost`. */
  ghostTargets: readonly BoardHoldTarget[];
  /** The ghost whose sheet is open, or null. */
  sheetGhost: LostHoldGhost | null;
  /** Live holds the sheet's "Use a hold nearby" would offer for `sheetGhost`. */
  sheetCandidates: readonly ReplacementCandidate[];
  /** Set while the climber is picking a replacement on the board. */
  replacing: LostHoldReplacement | null;
  /** The last pick was refused: that role is already full on the climb. */
  roleFull: boolean;
  openGhost: (lostHoldId: number) => void;
  /** Opens the sheet for the first ghost still on screen (the banner's tap). */
  openFirstGhost: () => void;
  closeSheet: () => void;
  /** "Use a hold nearby": close the sheet and highlight the candidates. */
  startReplacing: () => void;
  cancelReplacing: () => void;
  /** Called with every board tap first. True when the tap was a pick (or swallowed by picking). */
  interceptPaint: (holdId: number) => boolean;
};

type UseLostHoldGhostsArgs = {
  board: CreateClimbBoard;
  /** The climb being edited, or the remixed parent. */
  sourceClimbUuid: string | null;
  /** That climb's frames, still naming the lost holds. */
  sourceFrames: string | null;
  /** The wall's live hold ids, pinned when the editor mounted. */
  availableHoldIds: ReadonlySet<number> | undefined;
  /** The editor's frames as painted now. */
  frames: readonly LitUpHoldsMap[];
  /** Changes whenever the registered wall does. */
  sprayWallToken: string;
  placeLostHoldReplacement: (replacementHoldId: number, placements: readonly HoldPlacement[]) => boolean;
};

const NO_GHOSTS: readonly LostHoldGhost[] = [];
const NO_CANDIDATES: readonly ReplacementCandidate[] = [];

function paintedHoldIdsOf(frames: readonly LitUpHoldsMap[]): Set<number> {
  const ids = new Set<number>();
  for (const frame of frames) {
    for (const [holdKey, hold] of Object.entries(frame)) {
      if (hold.state !== 'OFF') ids.add(Number(holdKey));
    }
  }
  return ids;
}

/**
 * The create editor's lost-hold layer (#5493): which holds the climb lost,
 * where they were, and the swap that puts a live hold in their place.
 *
 * Kept out of the screen controller, which already owns save, autosave and the
 * paint machine; this only reads the frames and asks the controller to place a
 * hold.
 *
 * A ghost leaves the board once something stands in for it: the hold picked for
 * it this session, or any painted hold sitting on the spot (a restored autosave
 * carries the paint but not which ghost it answered). Undoing a swap brings the
 * ghost back, because it is derived from the paint rather than remembered.
 */
export function useLostHoldGhosts({
  board,
  sourceClimbUuid,
  sourceFrames,
  availableHoldIds,
  frames,
  sprayWallToken,
  placeLostHoldReplacement,
}: UseLostHoldGhostsArgs): LostHoldGhostsState {
  const isSpray = board.boardName === SPRAY_BOARD_NAME;

  const parsedSourceFrames = useMemo(
    () => (isSpray && sourceFrames ? buildInitialFrames(sourceFrames, board.boardName) : null),
    [isSpray, sourceFrames, board.boardName],
  );
  const lostHoldIds = useMemo(
    () => (parsedSourceFrames && availableHoldIds ? findLostHoldIds(parsedSourceFrames, availableHoldIds) : []),
    [parsedSourceFrames, availableHoldIds],
  );

  const variables = useMemo<GetClimbLostHoldsQueryVariables | null>(
    () =>
      lostHoldIds.length > 0 && sourceClimbUuid
        ? {
            boardName: board.boardName,
            layoutId: board.layoutId,
            sizeId: board.sizeId,
            setIds: board.setIds,
            angle: board.angle,
            climbUuid: sourceClimbUuid,
          }
        : null,
    [lostHoldIds.length, sourceClimbUuid, board.boardName, board.layoutId, board.sizeId, board.setIds, board.angle],
  );
  const lostHoldsQuery = useClimbLostHolds(variables);

  // The live wall, re-read whenever the registry hands over a new copy. Its
  // holds carry the reset review's move links; its homography is the one the
  // live holds were drawn through, so the ghosts land on the same photo.
  const wall = useMemo(
    () => (isSpray ? getSprayWall(board.layoutId) : null),
    // `sprayWallToken` is the reason to re-read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isSpray, board.layoutId, sprayWallToken],
  );
  const wallHoldById = useMemo(() => {
    const byId = new Map<number, SprayPhotoHold>();
    for (const hold of wall?.holds ?? []) byId.set(hold.id, hold);
    return byId;
  }, [wall]);

  const allGhosts = useMemo(() => {
    if (lostHoldsQuery.status !== 'ready' || !parsedSourceFrames || !availableHoldIds || !wall?.homography) {
      return NO_GHOSTS;
    }
    const photoHolds = mapCanonicalHoldsToPhoto(
      wall.homography,
      lostHoldsQuery.lostHolds.map((lostHold) => ({
        id: lostHold.id,
        cx: lostHold.cx,
        cy: lostHold.cy,
        r: lostHold.r,
        outline: lostHold.outline,
      })),
    );
    if (!photoHolds) return NO_GHOSTS;
    return buildLostHoldGhosts({
      sourceFrames: parsedSourceFrames,
      lostHolds: photoHolds,
      liveHoldIds: availableHoldIds,
    });
  }, [lostHoldsQuery, parsedSourceFrames, availableHoldIds, wall]);

  // Which live hold was picked for which ghost, this session.
  const [replacementByGhostId, setReplacementByGhostId] = useState<ReadonlyMap<number, number>>(() => new Map());

  const paintedHoldIds = useMemo(() => paintedHoldIdsOf(frames), [frames]);
  const visibleGhosts = useMemo(() => {
    if (allGhosts.length === 0) return NO_GHOSTS;
    const paintedCircles: HoldCircle[] = [];
    for (const holdId of paintedHoldIds) {
      const hold = wallHoldById.get(holdId);
      if (hold) paintedCircles.push(hold);
    }
    return allGhosts.filter((ghost) => {
      const replacementId = replacementByGhostId.get(ghost.id);
      if (replacementId !== undefined && paintedHoldIds.has(replacementId)) return false;
      return !isGhostCovered(ghost, paintedCircles);
    });
  }, [allGhosts, paintedHoldIds, wallHoldById, replacementByGhostId]);
  // The previous answer, handed back while the same ghosts survive a paint, so
  // the board's hit targets and tap handlers do not rebind on every tap.
  const previousGhostsRef = useRef<readonly LostHoldGhost[]>(NO_GHOSTS);
  const ghosts = useMemo(() => {
    const previous = previousGhostsRef.current;
    const unchanged =
      visibleGhosts.length === previous.length && visibleGhosts.every((ghost, index) => ghost === previous[index]);
    if (!unchanged) previousGhostsRef.current = visibleGhosts;
    return previousGhostsRef.current;
  }, [visibleGhosts]);

  const ghostTargets = useMemo<BoardHoldTarget[]>(
    () => ghosts.map((ghost) => ({ id: ghost.id, cx: ghost.cx, cy: ghost.cy, r: ghost.r })),
    [ghosts],
  );

  const status: LostHoldsStatus =
    lostHoldIds.length === 0
      ? 'none'
      : allGhosts.length > 0
        ? 'ready'
        : lostHoldsQuery.status === 'unavailable'
          ? 'unavailable'
          : lostHoldsQuery.status === 'ready'
            ? 'noPositions'
            : 'countOnly';
  const count = status === 'ready' ? ghosts.length : lostHoldIds.length;

  const candidatesFor = useCallback(
    (ghost: LostHoldGhost) => rankReplacementCandidates({ ghost, liveHolds: wall?.holds ?? [], paintedHoldIds }),
    [wall, paintedHoldIds],
  );

  const [sheetGhostId, setSheetGhostId] = useState<number | null>(null);
  const [replacingGhostId, setReplacingGhostId] = useState<number | null>(null);
  const [roleFull, setRoleFull] = useState(false);

  const sheetGhost = useMemo(
    () => (sheetGhostId === null ? null : (ghosts.find((ghost) => ghost.id === sheetGhostId) ?? null)),
    [ghosts, sheetGhostId],
  );
  const sheetCandidates = useMemo(
    () => (sheetGhost ? candidatesFor(sheetGhost) : NO_CANDIDATES),
    [sheetGhost, candidatesFor],
  );
  const replacing = useMemo<LostHoldReplacement | null>(() => {
    if (replacingGhostId === null) return null;
    const ghost = ghosts.find((candidate) => candidate.id === replacingGhostId);
    if (!ghost) return null;
    const candidates = candidatesFor(ghost);
    const candidateHolds: HighlightedHold[] = [];
    for (const candidate of candidates) {
      const hold = wallHoldById.get(candidate.holdId);
      if (hold) candidateHolds.push({ ...hold, isSuccessor: candidate.isSuccessor });
    }
    return { ghost, candidates, candidateHolds };
  }, [ghosts, replacingGhostId, candidatesFor, wallHoldById]);

  // A ghost answered some other way (undo history, a hand-painted successor)
  // ends its own pick: the mode has nothing left to replace.
  useEffect(() => {
    if (replacingGhostId !== null && !ghosts.some((ghost) => ghost.id === replacingGhostId)) {
      setReplacingGhostId(null);
      setRoleFull(false);
    }
    // The same for an open sheet: forgotten, so an undo that brings the ghost
    // back does not bring its sheet back up unasked.
    if (sheetGhostId !== null && !ghosts.some((ghost) => ghost.id === sheetGhostId)) {
      setSheetGhostId(null);
    }
  }, [ghosts, replacingGhostId, sheetGhostId]);

  const openGhost = useCallback((lostHoldId: number) => {
    hapticSelection();
    setReplacingGhostId(null);
    setRoleFull(false);
    setSheetGhostId(lostHoldId);
  }, []);
  const openFirstGhost = useCallback(() => {
    if (ghosts.length > 0) openGhost(ghosts[0].id);
  }, [ghosts, openGhost]);
  const closeSheet = useCallback(() => setSheetGhostId(null), []);
  const startReplacing = useCallback(() => {
    setReplacingGhostId(sheetGhostId);
    setRoleFull(false);
    setSheetGhostId(null);
  }, [sheetGhostId]);
  const cancelReplacing = useCallback(() => {
    setReplacingGhostId(null);
    setRoleFull(false);
  }, []);

  const interceptPaint = useCallback(
    (holdId: number): boolean => {
      if (!replacing) return false;
      // Only a highlighted hold is a pick. Any other tap is swallowed rather than
      // painted: the banner says what a tap does right now, and a stray paint in
      // the middle of a swap is the surprise this mode exists to prevent.
      if (!replacing.candidates.some((candidate) => candidate.holdId === holdId)) return true;
      const placed = placeLostHoldReplacement(holdId, replacing.ghost.placements);
      if (!placed) {
        hapticWarning();
        setRoleFull(true);
        return true;
      }
      hapticSuccess();
      setReplacementByGhostId((previous) => new Map(previous).set(replacing.ghost.id, holdId));
      setReplacingGhostId(null);
      setRoleFull(false);
      return true;
    },
    [replacing, placeLostHoldReplacement],
  );

  return useMemo(
    () => ({
      status,
      count,
      ghosts,
      ghostTargets,
      sheetGhost,
      sheetCandidates,
      replacing,
      roleFull,
      openGhost,
      openFirstGhost,
      closeSheet,
      startReplacing,
      cancelReplacing,
      interceptPaint,
    }),
    [
      status,
      count,
      ghosts,
      ghostTargets,
      sheetGhost,
      sheetCandidates,
      replacing,
      roleFull,
      openGhost,
      openFirstGhost,
      closeSheet,
      startReplacing,
      cancelReplacing,
      interceptPaint,
    ],
  );
}
