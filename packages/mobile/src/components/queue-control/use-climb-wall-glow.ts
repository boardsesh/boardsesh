import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { Climb } from '@boardsesh/queue';
import type { BoardName } from '@boardsesh/shared-schema';
import { getBoardRenderData } from '../../lib/board-details';
import { resolveClimbRenderBoard } from '../../lib/boards/climb-render-board';
import { sprayCacheToken, subscribeToSprayWalls } from '../../lib/spray/spray-wall-registry';
import type { BoardConfig } from '../../providers/drawer-host-provider';
import { useParseFrames } from '../board-renderer/use-parse-frames';
import type { HoldPlacement } from '../board-renderer/types';
import { useHoldStateColors } from '../play-drawer/use-hold-state-colors';
import type { WallGlowInput } from '../play-drawer/use-wall-glow';
import { buildWallGlowInput } from '../play-drawer/wall-glow-input';

const EMPTY_HOLD_PLACEMENTS: HoldPlacement[] = [];
const subscribeToNoSprayWall = (): (() => void) => () => {};

/** Local hold geometry and colours only: this surface never requests wall data or board images. */
export function useClimbWallGlow(
  climb: Climb,
  boardConfig: BoardConfig | null,
  enabled: boolean,
): WallGlowInput | null {
  'use no memo';

  const { uuid, frames, boardType, layoutId, angle, compatibleSizeIds } = climb;
  const mirrored = climb.mirrored === true;
  const glowEnabled = enabled && frames.length > 0;
  const climbSprayLayout = glowEnabled && boardType === 'spray' ? layoutId : null;
  const activeSprayLayout = glowEnabled && boardConfig?.boardName === 'spray' ? boardConfig.layoutId : null;
  // Unlike useSprayWallToken, this subscription does not request a missing wall.
  // Its active board surface owns loading; arriving or reset geometry wakes us.
  const getSprayToken = useCallback(
    () =>
      `${climbSprayLayout == null ? '' : sprayCacheToken('spray', climbSprayLayout)}|${activeSprayLayout == null ? '' : sprayCacheToken('spray', activeSprayLayout)}`,
    [climbSprayLayout, activeSprayLayout],
  );
  const sprayToken = useSyncExternalStore(
    climbSprayLayout == null && activeSprayLayout == null ? subscribeToNoSprayWall : subscribeToSprayWalls,
    getSprayToken,
    getSprayToken,
  );
  const renderBoard = useMemo(
    () =>
      glowEnabled
        ? (resolveClimbRenderBoard({ boardType, layoutId, angle, frames, compatibleSizeIds }, boardConfig, {
            loadMissingSpray: false,
          })?.boardConfig ?? boardConfig)
        : null,
    [glowEnabled, boardType, layoutId, angle, frames, compatibleSizeIds, boardConfig, sprayToken],
  );
  const setIds = useMemo(
    () =>
      renderBoard?.setIds
        .split(',')
        .map((setId) => Number(setId))
        .filter((setId) => Number.isFinite(setId)) ?? [],
    [renderBoard?.setIds],
  );
  const boardRenderData = useMemo(
    () =>
      renderBoard && setIds.length > 0
        ? getBoardRenderData({
            boardName: renderBoard.boardName as BoardName,
            layoutId: renderBoard.layoutId,
            sizeId: renderBoard.sizeId,
            setIds,
          })
        : null,
    [renderBoard, setIds, sprayToken],
  );
  const parsedHolds = useParseFrames(
    boardRenderData ? frames : '',
    (renderBoard?.boardName ?? 'kilter') as BoardName,
    boardRenderData?.holdsData ?? EMPTY_HOLD_PLACEMENTS,
    mirrored,
  );
  const roleColors = useHoldStateColors((renderBoard?.boardName ?? 'kilter') as BoardName, renderBoard?.layoutId ?? 0);
  return useMemo(
    () =>
      glowEnabled && boardRenderData
        ? buildWallGlowInput({
            parsedHolds,
            roleColors,
            boardWidth: boardRenderData.boardWidth,
            boardHeight: boardRenderData.boardHeight,
            climbUuid: uuid,
            frames,
            mirrored,
          })
        : null,
    [glowEnabled, boardRenderData, parsedHolds, roleColors, uuid, frames, mirrored],
  );
}
