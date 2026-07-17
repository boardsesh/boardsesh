import type { BoardName } from '@boardsesh/shared-schema';
import { getBoardStrokeWidthMultiplier } from '@boardsesh/board-constants/hold-states';
import { OG_BOARD_PADDING_X, OG_BOARD_PADDING_Y } from './background';
import { OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH } from './headers';
import type { HoldStateRecord, RenderableBoardDetails, WasmRenderConfig } from './types';

/** Thumbnail render width in pixels. Covers 3x retina at ~64px CSS display. */
export const THUMBNAIL_WIDTH = 200;

type BuildRenderConfigParams = {
  boardName: string;
  boardDetails: RenderableBoardDetails;
  frames: string;
  thumbnail: boolean;
  isOgVariant: boolean;
  /** Per-board hold-state colour/style map (from HOLD_STATE_MAP[boardName]). */
  boardStates: HoldStateRecord;
  /** Injected so web can pass its (mockable) THUMBNAIL_WIDTH; defaults to the shared constant. */
  thumbnailWidth?: number;
};

export type RenderConfigResult = {
  config: WasmRenderConfig;
  outputWidth: number;
  ogScale: number | null;
};

/**
 * Assemble the WASM render config for a climb: computes the output width
 * (OG-scaled, thumbnail, or native), builds the hold-state colour map, and
 * emits the config object the overlay renderer consumes. Pure — no I/O.
 */
export function buildRenderConfig({
  boardName,
  boardDetails,
  frames,
  thumbnail,
  isOgVariant,
  boardStates,
  thumbnailWidth = THUMBNAIL_WIDTH,
}: BuildRenderConfigParams): RenderConfigResult {
  const ogScale = isOgVariant
    ? Math.min(
        (OG_IMAGE_WIDTH - OG_BOARD_PADDING_X * 2) / boardDetails.boardWidth,
        (OG_IMAGE_HEIGHT - OG_BOARD_PADDING_Y * 2) / boardDetails.boardHeight,
      )
    : null;

  const computeOutputWidth = () => {
    if (isOgVariant) return Math.max(1, Math.round(boardDetails.boardWidth * (ogScale || 1)));
    if (thumbnail) return thumbnailWidth;
    return boardDetails.boardWidth;
  };
  const outputWidth = computeOutputWidth();

  // Prefer each role's calibrated on-screen displayColor over its raw LED
  // color — the LED color is only correct for driving physical board
  // hardware over BLE (see light-control-drawer.tsx), not for what a viewer
  // sees on screen (issue #2202: raw LED blue renders far too dark against a
  // busy board photo). Boards without a displayColor (e.g. Kilter) render
  // unchanged.
  const holdStateMap: Record<number, { color: string; renderStyle?: string }> = {};
  for (const [code, info] of Object.entries(boardStates)) {
    holdStateMap[Number(code)] = {
      color: info.displayColor ?? info.color,
      ...(info.renderStyle ? { renderStyle: info.renderStyle } : {}),
    };
  }

  const config: WasmRenderConfig = {
    board_name: boardName,
    board_width: boardDetails.boardWidth,
    board_height: boardDetails.boardHeight,
    output_width: outputWidth,
    frames,
    mirrored: false,
    // OG cards get the thumbnail stroke treatment (thicker rings, larger
    // markers) so holds stay readable at chat-preview sizes.
    thumbnail: thumbnail || isOgVariant,
    stroke_width_multiplier: getBoardStrokeWidthMultiplier(boardName as BoardName),
    holds: boardDetails.holdsData.map((hold) => ({
      id: hold.id,
      mirroredHoldId: hold.mirroredHoldId,
      cx: hold.cx,
      cy: hold.cy,
      r: hold.r,
    })),
    hold_state_map: holdStateMap,
  };

  return { config, outputWidth, ogScale };
}
