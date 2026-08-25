import { resolvePackagedBoardAsset } from '../../modules/board-renderer/src/index';
import type { BoardBackgroundAsset } from './board-backgrounds-manifest';

export function resolveBoardBackgroundAsset(asset: BoardBackgroundAsset, _manifestKey: string): string | null {
  return resolvePackagedBoardAsset(asset.objectKey);
}
