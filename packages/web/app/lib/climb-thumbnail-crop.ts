import { HOLD_STATE_MAP, parseFramesSegments } from '@boardsesh/board-constants/hold-states';
import type { BoardName } from '@boardsesh/shared-schema';

/** Four normalized coordinates; geometry stays on the server. */
export type ClimbThumbnailCrop = { x: number; y: number; width: number; height: number };
type HoldCentre = { id: number; cx: number; cy: number; r: number };

/** Match the renderer's first-frame snapshot, including the ring around each hold. */
export function getClimbThumbnailCrop(
  board: { board_name: BoardName; boardWidth: number; boardHeight: number; holdsData: readonly HoldCentre[] },
  frames: string,
): ClimbThumbnailCrop | null {
  const { boardWidth, boardHeight } = board;
  if (!Number.isFinite(boardWidth) || !Number.isFinite(boardHeight) || boardWidth <= 0 || boardHeight <= 0) return null;
  const firstFrame = parseFramesSegments(frames)[0]?.body ?? '';
  const litIds = new Set<number>();
  for (const token of firstFrame.matchAll(/p(\d+)r(\d+)/g)) {
    const role = HOLD_STATE_MAP[board.board_name]?.[Number(token[2])];
    if (!role) return null;
    if (role.name !== 'OFF' && role.name !== 'NOT') litIds.add(Number(token[1]));
  }
  if (litIds.size === 0) return null;
  const holds = board.holdsData.filter((hold) => litIds.has(hold.id));
  if (
    holds.length !== litIds.size ||
    holds.some((hold) => ![hold.cx, hold.cy, hold.r].every(Number.isFinite) || hold.r <= 0)
  )
    return null;
  const left = Math.min(...holds.map((hold) => hold.cx - hold.r));
  const right = Math.max(...holds.map((hold) => hold.cx + hold.r));
  const top = Math.min(...holds.map((hold) => hold.cy - hold.r));
  const bottom = Math.max(...holds.map((hold) => hold.cy + hold.r));
  const paddingX = (right - left) * 0.1;
  const paddingY = (bottom - top) * 0.1;
  const x = Math.max(0, left - paddingX);
  const y = Math.max(0, top - paddingY);
  const width = Math.min(boardWidth, right + paddingX) - x;
  const height = Math.min(boardHeight, bottom + paddingY) - y;
  if (width <= 0 || height <= 0) return null;
  return { x: x / boardWidth, y: y / boardHeight, width: width / boardWidth, height: height / boardHeight };
}

/** Fit the entire crop inside the fixed thumbnail slot, mirroring the existing art once. */
export function getClimbThumbnailCropPlacement(
  crop: ClimbThumbnailCrop,
  boardWidth: number,
  boardHeight: number,
  mirrored: boolean,
) {
  const slotAspect = 5 / 7;
  const cropAspect = (crop.width * boardWidth) / (crop.height * boardHeight);
  const occupiedWidth = Math.min(1, cropAspect / slotAspect);
  const occupiedHeight = Math.min(1, slotAspect / cropAspect);
  const cropX = mirrored ? Math.max(0, 1 - crop.x - crop.width) : crop.x;
  return {
    width: `${(occupiedWidth / crop.width) * 100}%`,
    left: `${((1 - occupiedWidth) / 2) * 100}%`,
    top: `${((1 - occupiedHeight) / 2) * 100}%`,
    transform: `translate(-${cropX * 100}%, -${crop.y * 100}%)`,
  };
}

const WHOLE_BOARD: ClimbThumbnailCrop = { x: 0, y: 0, width: 1, height: 1 };

/** Centre the art on its region, then slide it back over the slot wherever it is big enough to cover it. */
function coverOffset(centredOffset: number, artSize: number, slotSize: number): number {
  if (artSize <= slotSize) return (slotSize - artSize) / 2;
  return Math.min(0, Math.max(slotSize - artSize, centredOffset));
}

const toPercent = (fraction: number) => `${fraction * 100}%`;

/**
 * Place a climb's art in a slot of any shape (a playlist cover cell) so its
 * lit-hold region fits whole and centred.
 *
 * Unlike `getClimbThumbnailCropPlacement`, which centres the region and lets
 * the art stop short of the slot's edge, this slides the art back so it keeps
 * covering the slot: a climb that tops out against the board's edge shows more
 * board instead of an empty strip. Without a crop the whole board is fitted.
 *
 * `left` and `width` are shares of the slot's width and `top` a share of its
 * height, for an absolutely positioned box whose art keeps the board's own
 * aspect ratio.
 */
export function getClimbCoverPlacement(
  crop: ClimbThumbnailCrop | null | undefined,
  boardWidth: number,
  boardHeight: number,
  mirrored: boolean,
  slotAspect: number,
): { left: string; top: string; width: string } {
  const region = crop ?? WHOLE_BOARD;
  const regionAspect = (region.width * boardWidth) / (region.height * boardHeight);
  // Every length below is in slot widths.
  const slotHeight = 1 / slotAspect;
  const regionWidth = Math.min(1, regionAspect / slotAspect);
  const artWidth = regionWidth / region.width;
  const artHeight = (artWidth * boardHeight) / boardWidth;
  // The art box is flipped as a whole, so the region sits mirrored inside it.
  const regionX = mirrored ? 1 - region.x - region.width : region.x;
  const left = coverOffset(0.5 - (regionX + region.width / 2) * artWidth, artWidth, 1);
  const top = coverOffset(slotHeight / 2 - (region.y + region.height / 2) * artHeight, artHeight, slotHeight);
  return { left: toPercent(left), top: toPercent(top / slotHeight), width: toPercent(artWidth) };
}
