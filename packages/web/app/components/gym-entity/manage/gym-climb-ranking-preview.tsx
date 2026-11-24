'use client';

import Box from '@mui/material/Box';
import { BOARD_FIELD_COLORS } from '@boardsesh/board-look';
import { convertLitUpHoldsStringToMap, toFlatFrames } from '@boardsesh/board-constants/hold-states';
import { GET_CLIMB, GET_SPRAY_CLIMB, GET_SPRAY_WALL_BY_LAYOUT, GET_SPRAY_WALL_RENDER_DATA } from '@boardsesh/graphql';
import type { SprayWall, SprayWallRenderData } from '@boardsesh/graphql/generated/graphql';
import { SUPPORTED_BOARDS, type Climb, type GymClimbRankingTarget } from '@boardsesh/shared-schema';
import ClimbBoardStage from '@/app/components/climb-front-door/climb-board-stage';
import { getImageUrl, hasDarkBoardArt } from '@/app/components/board-renderer/util';
import SprayBoardArt from '@/app/components/spray-wall/spray-board-art';
import { getBoardDetailsForBoard } from '@/app/lib/board-utils';
import {
  buildSprayLitHoldMarks,
  resolveSprayWallDrawing,
  type SprayLitHoldMark,
} from '@/app/lib/spray/spray-climb-view';
import { constructBoardSlugViewUrl } from '@/app/lib/url-utils';
import type { BoardDetails } from '@/app/lib/types';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';

export type GymClimbRankingPreview =
  | { kind: 'public'; path: string }
  | {
      kind: 'spray';
      imageUrl: string;
      frameWidth: number;
      frameHeight: number;
      marks: SprayLitHoldMark[];
    }
  | { kind: 'catalogue'; board: BoardDetails; frames: string; mirrored: boolean };

export async function readGymClimbRankingPreview(
  token: string,
  target: GymClimbRankingTarget,
  signal: AbortSignal,
): Promise<GymClimbRankingPreview> {
  if (target.shareable) {
    const hash = target.isMirror ? '#mirrored' : '';
    return {
      kind: 'public',
      path:
        constructBoardSlugViewUrl(encodeURIComponent(target.boardSlug), target.angle, target.climbUuid, target.name) +
        hash,
    };
  }
  const client = createGraphQLHttpClient(token);
  const boardName = SUPPORTED_BOARDS.find((name) => name === target.boardType);
  if (!boardName) throw new Error('Ranking board is unavailable');
  const { climb } = await client.request<{ climb: Climb | null }>({
    document: boardName === 'spray' ? GET_SPRAY_CLIMB : GET_CLIMB,
    variables: {
      boardName,
      layoutId: target.layoutId,
      sizeId: target.sizeId,
      setIds: target.setIds,
      angle: target.angle,
      climbUuid: target.climbUuid,
    },
    signal,
  });
  if (!climb?.frames || climb.uuid !== target.climbUuid || climb.angle !== target.angle || climb.is_draft) {
    throw new Error('Ranking climb is unavailable');
  }
  if (boardName !== 'spray') {
    const board = getBoardDetailsForBoard({
      board_name: boardName,
      layout_id: target.layoutId,
      size_id: target.sizeId,
      set_ids: target.setIds.split(',').map(Number),
    });
    return { kind: 'catalogue', board, frames: climb.frames, mirrored: target.isMirror };
  }

  // The by-layout read uses the signed-in viewer's independent access. Never
  // resolve or construct the share-link capability for a ranked wall.
  const { sprayWallByLayout: wall } = await client.request<{ sprayWallByLayout: SprayWall | null }>({
    document: GET_SPRAY_WALL_BY_LAYOUT,
    variables: { layoutId: target.layoutId },
    signal,
  });
  if (
    !wall?.currentVersion ||
    wall.hiddenAt ||
    wall.uuid !== target.logicalBoardUuid ||
    wall.board.angle !== target.angle
  ) {
    throw new Error('Ranking wall is unavailable');
  }
  const { sprayWallRenderData: render } = await client.request<{ sprayWallRenderData: SprayWallRenderData | null }>({
    document: GET_SPRAY_WALL_RENDER_DATA,
    variables: { uuid: wall.uuid, version: wall.currentVersion.number },
    signal,
  });
  if (
    !render ||
    render.wall.hiddenAt ||
    render.wall.board.angle !== target.angle ||
    render.wall.uuid !== wall.uuid ||
    render.wall.currentVersion?.number !== render.versionNumber ||
    render.versionNumber !== wall.currentVersion.number
  ) {
    throw new Error('Ranking wall is unavailable');
  }
  const drawing = resolveSprayWallDrawing({
    photoUrl: render.photo.url,
    artUrl: null,
    art: null,
    photoWidth: render.photo.width,
    photoHeight: render.photo.height,
    boardWidth: render.boardWidth,
    boardHeight: render.boardHeight,
    homography: render.homography,
    darkFieldColor: BOARD_FIELD_COLORS.dark,
  });
  if (!drawing || drawing.frame.width <= 0 || drawing.frame.height <= 0) {
    throw new Error('Ranking wall is unavailable');
  }
  const holds = render.holds.map(({ id, cx, cy, r, outline }) => ({ id, cx, cy, r, outline: outline ?? null }));
  return {
    kind: 'spray',
    imageUrl: drawing.imageUrl,
    frameWidth: drawing.frame.width,
    frameHeight: drawing.frame.height,
    marks: buildSprayLitHoldMarks({ frames: climb.frames, holds, homography: drawing.homography }),
  };
}

export function GymClimbRankingPrivateArt({
  preview,
  alt,
}: {
  preview: Exclude<GymClimbRankingPreview, { kind: 'public' }>;
  alt: string;
}) {
  if (preview.kind === 'spray') {
    return (
      <SprayBoardArt
        imageUrl={preview.imageUrl}
        photoAlt={alt}
        frameWidth={preview.frameWidth}
        frameHeight={preview.frameHeight}
        marks={preview.marks}
        referrerPolicy="no-referrer"
      />
    );
  }
  const { board, frames, mirrored } = preview;
  const lit = convertLitUpHoldsStringToMap(toFlatFrames(frames, board.board_name), board.board_name)[0] ?? {};
  // Only static reference board photos are URL-addressed. The selected frames
  // stay inline, because even the image cache key would reveal a private climb.
  return (
    <ClimbBoardStage
      backgroundHasDarkArt={hasDarkBoardArt(board.board_name)}
      backgroundUrls={Object.keys(board.images_to_holds).map((key) => getImageUrl(key, board.board_name))}
      boardWidth={board.boardWidth}
      boardHeight={board.boardHeight}
      alt={alt}
      mirrored={mirrored}
      overlay={
        <Box component="svg" role="img" aria-label={alt} viewBox={`0 0 ${board.boardWidth} ${board.boardHeight}`}>
          {board.holdsData
            .filter(({ id }) => lit[id])
            .map(({ id, cx, cy, r }) => (
              <circle
                key={id}
                cx={cx}
                cy={cy}
                r={Math.max(r, board.boardWidth / 90)}
                stroke={lit[id].displayColor || lit[id].color}
                strokeWidth={board.boardWidth / 240}
                fill="transparent"
              />
            ))}
        </Box>
      }
    />
  );
}
