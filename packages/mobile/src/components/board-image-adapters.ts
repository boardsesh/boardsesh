import type { BoardName } from '@boardsesh/shared-schema';
import { loadQuantumBoardImage } from './quantum/quantum-board-image-loader';

export type RuntimeBoardImageLoader = typeof loadQuantumBoardImage;

type BoardImageAdapter = Readonly<{
  loadImage: RuntimeBoardImageLoader | null;
  prewarmRaster: boolean;
}>;

const layeredImage: BoardImageAdapter = { loadImage: null, prewarmRaster: true };
const runtimeImage: BoardImageAdapter = { loadImage: loadQuantumBoardImage, prewarmRaster: false };

/** Full boards, list thumbnails and prewarming must select the same renderer. */
export function getBoardImageAdapter(boardName: BoardName): BoardImageAdapter {
  return boardName === 'quantum' ? runtimeImage : layeredImage;
}
