import { useMemo } from 'react';
import type { Climb } from '@boardsesh/shared-schema';
import { getBoardRenderData } from '../../lib/board-details';
import { useParseFrames } from '../../components/board-renderer/use-parse-frames';
import { useHoldStateColors } from '../../components/play-drawer/use-hold-state-colors';
import { buildWallGlowInput } from '../../components/play-drawer/wall-glow-input';
import type { WallGlowInput } from '../../components/play-drawer/use-wall-glow';
import type { StoryBoardConfig } from '../fixtures/boards';

const NO_HOLDS: never[] = [];

/**
 * The driving wall button's frost for a story player: the same lit-hold input
 * `PlayCore` builds from the climb on screen, from the story's bundled board.
 * Without it a driving story falls back to the flat amber fill, which is not
 * what a driving climber sees (the store shots showed exactly that).
 * `shown` false (not driving, or a wall with no lights) skips the parse.
 */
export function useStoryWallGlow({
  board,
  climb,
  mirrored,
  shown,
}: {
  board: StoryBoardConfig;
  climb: Climb;
  mirrored: boolean;
  shown: boolean;
}): WallGlowInput | null {
  const renderData = useMemo(
    () => getBoardRenderData({ ...board, setIds: board.setIds.split(',').map(Number) }),
    [board],
  );
  const frames = shown ? climb.frames : '';
  const parsed = useParseFrames(frames, board.boardName, renderData?.holdsData ?? NO_HOLDS, mirrored);
  const roleColors = useHoldStateColors(board.boardName, board.layoutId);
  return useMemo(() => {
    if (!shown || !renderData) return null;
    return buildWallGlowInput({
      parsedHolds: parsed,
      roleColors,
      boardWidth: renderData.boardWidth,
      boardHeight: renderData.boardHeight,
      climbUuid: climb.uuid,
      frames,
      mirrored,
    });
  }, [shown, renderData, parsed, roleColors, climb.uuid, frames, mirrored]);
}
