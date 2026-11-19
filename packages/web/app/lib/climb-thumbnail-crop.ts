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
