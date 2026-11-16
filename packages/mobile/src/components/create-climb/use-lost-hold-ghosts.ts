import { useCallback, useMemo, useState } from 'react';
import type { BoardName, LitUpHoldsMap } from '@boardsesh/shared-schema';
import { buildInitialFrames } from '@boardsesh/create-climb-react';
import type { GetClimbLostHoldsQueryVariables } from '@boardsesh/graphql/operations';
import { useClimbLostHolds } from '../../lib/graphql/hooks/use-climb-lost-holds';
import { getSprayWall, SPRAY_BOARD_NAME } from '../../lib/spray/spray-wall-registry';
import type { SprayPhotoHold } from '../../lib/spray/spray-hold-geometry';
import { mapCanonicalHoldsForDrawnWall } from '../../lib/spray/spray-drawn-geometry';
import { hapticSelection } from '../../lib/haptics';
import type { BoardHoldTarget } from '../../lib/create-board-holds';
import type { CreateClimbBoard } from './use-create-climb-screen';

/** A hold the remixed climb used that the wall no longer has, in photo pixels. */
export type LostHoldGhost = Pick<SprayPhotoHold, 'id' | 'cx' | 'cy' | 'r' | 'outline'>;

export type LostHoldGhostsState = {
  /** Grey rings still on the board. Save waits until there are none. */
  ghosts: readonly LostHoldGhost[];
  /** The same rings as tap targets, so a tap on one reaches `dismissGhost`. */
  ghostTargets: readonly BoardHoldTarget[];
  /** The climber tapped a ring: it leaves the board. */
  dismissGhost: (lostHoldId: number) => void;
};

type UseLostHoldGhostsArgs = {
  board: CreateClimbBoard;
  /** The remixed climb's uuid. Null for a new climb, and for editing a climb in place. */
  parentClimbUuid: string | null;
  /** The remixed climb's frames, still naming the holds it lost. */
  sourceFrames: string | null;
  /** The wall's live hold ids, pinned when the editor mounted; undefined off spray. */
  availableHoldIds: ReadonlySet<number> | undefined;
  /** Changes whenever the registered wall does. */
  sprayWallToken: string;
};

const NO_GHOSTS: readonly LostHoldGhost[] = [];
const NO_TARGETS: readonly BoardHoldTarget[] = [];

/**
 * The hold ids a climb names that the device's wall no longer has.
 *
 * Device-derived on purpose: it is exactly the set the editor's seed dropped
 * (`availableHoldIds`), so a ring is drawn for each hold missing from the editor
 * and for nothing else.
 */
export function findLostHoldIds(sourceFrames: readonly LitUpHoldsMap[], liveHoldIds: ReadonlySet<number>): number[] {
  const lost = new Set<number>();
  for (const frame of sourceFrames) {
    for (const [holdKey, hold] of Object.entries(frame)) {
      const holdId = Number(holdKey);
      if (hold.state !== 'OFF' && !liveHoldIds.has(holdId)) lost.add(holdId);
    }
  }
  return [...lost].sort((left, right) => left - right);
}

/**
 * The remix editor's grey rings: where each hold the parent climb lost used to
 * be (`docs/spray-walls.md`, "Remixing a climb that lost a hold").
 *
 * Only in a remix of a climb that lost a hold, never when a climb is edited in
 * place. The editor already opened without those holds; each ring says one was
 * there, and Save waits until the climber has tapped every ring away, so a
 * remix is never published without the setter having seen what changed. A tap
 * removes the ring and nothing else: no replacement is suggested.
 *
 * Fails open: with no signal, a failed read, or a wall registered without a
 * homography there is nothing to draw, so nothing holds Save back.
 */
export function useLostHoldGhosts({
  board,
  parentClimbUuid,
  sourceFrames,
  availableHoldIds,
  sprayWallToken,
}: UseLostHoldGhostsArgs): LostHoldGhostsState {
  const isSpray = board.boardName === SPRAY_BOARD_NAME;

  const lostHoldIds = useMemo(() => {
    if (!isSpray || !parentClimbUuid || !sourceFrames || !availableHoldIds) return [];
    return findLostHoldIds(buildInitialFrames(sourceFrames, board.boardName as BoardName), availableHoldIds);
  }, [isSpray, parentClimbUuid, sourceFrames, availableHoldIds, board.boardName]);

  const variables = useMemo<GetClimbLostHoldsQueryVariables | null>(
    () =>
      lostHoldIds.length > 0 && parentClimbUuid
        ? {
            boardName: board.boardName,
            layoutId: board.layoutId,
            sizeId: board.sizeId,
            setIds: board.setIds,
            angle: board.angle,
            climbUuid: parentClimbUuid,
          }
        : null,
    [lostHoldIds.length, parentClimbUuid, board.boardName, board.layoutId, board.sizeId, board.setIds, board.angle],
  );
  const lostHoldsQuery = useClimbLostHolds(variables);

  // The live wall, re-read whenever the registry hands over a new copy: the
  // rings are mapped the way its live holds are drawn (photo or generated
  // look), so they land on the same picture.
  const wall = useMemo(
    () => (isSpray ? getSprayWall(board.layoutId) : null),
    // `sprayWallToken` is the reason to re-read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isSpray, board.layoutId, sprayWallToken],
  );

  const allGhosts = useMemo(() => {
    if (lostHoldsQuery.status !== 'ready' || !wall || lostHoldIds.length === 0) return NO_GHOSTS;
    const lost = new Set(lostHoldIds);
    // Onto the picture the live holds are drawn on: the photo through the
    // inverse homography, or a generated look by its scale.
    const photoHolds = mapCanonicalHoldsForDrawnWall(
      wall,
      lostHoldsQuery.lostHolds
        .filter((lostHold) => lost.has(lostHold.id))
        .map((lostHold) => ({
          id: lostHold.id,
          cx: lostHold.cx,
          cy: lostHold.cy,
          r: lostHold.r,
          outline: lostHold.outline,
        })),
    );
    if (!photoHolds || photoHolds.length === 0) return NO_GHOSTS;
    return photoHolds.map(({ id, cx, cy, r, outline }) => ({ id, cx, cy, r, outline }));
  }, [lostHoldsQuery, wall, lostHoldIds]);

  const [dismissedIds, setDismissedIds] = useState<ReadonlySet<number>>(() => new Set());
  const ghosts = useMemo(
    () => (dismissedIds.size === 0 ? allGhosts : allGhosts.filter((ghost) => !dismissedIds.has(ghost.id))),
    [allGhosts, dismissedIds],
  );
  const ghostTargets = useMemo<readonly BoardHoldTarget[]>(
    () => (ghosts.length === 0 ? NO_TARGETS : ghosts.map(({ id, cx, cy, r }) => ({ id, cx, cy, r }))),
    [ghosts],
  );

  const dismissGhost = useCallback((lostHoldId: number) => {
    hapticSelection();
    setDismissedIds((previous) => (previous.has(lostHoldId) ? previous : new Set(previous).add(lostHoldId)));
  }, []);

  return useMemo(() => ({ ghosts, ghostTargets, dismissGhost }), [ghosts, ghostTargets, dismissGhost]);
}
