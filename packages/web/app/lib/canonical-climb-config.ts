import { getSetsForLayoutAndSize, getSizesForLayoutId } from '@boardsesh/board-constants/catalog-metadata';
import { getSizeRank } from '@boardsesh/board-constants/size-comparison';
import { getDefaultRenderBoard } from '@boardsesh/board-config/resolve-render-board';
import { parseBoardListPath, tryBuildReadableClimbListPath } from '@boardsesh/play-view/readable-url-utils';
import type { BoardName, RenderBoardConfig } from '@boardsesh/shared-schema';

export type ClimbConfigCompatibility = {
  compatibleSizeIds?: readonly number[] | null;
  requiredSetIds?: readonly number[] | null;
};

const configsByLayout = new Map<string, readonly RenderBoardConfig[]>();

function hasReadableRoute(boardName: BoardName, config: RenderBoardConfig): boolean {
  if (config.setIds.length === 0) return false;
  const setIds = config.setIds.join(',');
  const path = tryBuildReadableClimbListPath({ ...config, boardName, setIds, angle: 40 });
  const parsed = path && parseBoardListPath(path);
  return (
    !!parsed &&
    parsed.boardName === boardName &&
    parsed.layoutId === config.layoutId &&
    parsed.sizeId === config.sizeId &&
    parsed.setIds
      .split(',')
      .map(Number)
      .sort((left, right) => left - right)
      .join(',') === [...config.setIds].sort((left, right) => left - right).join(',')
  );
}

function catalogConfigs(boardName: BoardName, layoutId: number): readonly RenderBoardConfig[] {
  const key = `${boardName}:${layoutId}`;
  const cached = configsByLayout.get(key);
  if (cached) return cached;

  const defaultConfig = getDefaultRenderBoard(boardName, layoutId);
  const otherSizes = getSizesForLayoutId(boardName, layoutId)
    .filter((size) => size.id !== defaultConfig?.sizeId)
    .sort((left, right) => getSizeRank(boardName, right.id) - getSizeRank(boardName, left.id) || left.id - right.id);
  const configs = [
    ...(defaultConfig ? [defaultConfig] : []),
    ...otherSizes.map((size) => ({
      layoutId,
      sizeId: size.id,
      setIds: getSetsForLayoutAndSize(boardName, layoutId, size.id).map((set) => set.id),
    })),
  ].filter((config) => hasReadableRoute(boardName, config));
  // Only memoize known catalogue layouts. Missing request IDs cannot grow this map.
  if (configs.length > 0) configsByLayout.set(key, configs);
  return configs;
}

/** A crawl URL uses the largest fitting catalogue size and all its available sets. */
export function resolveCanonicalClimbConfig(
  boardName: BoardName,
  layoutId: number,
  { compatibleSizeIds, requiredSetIds }: ClimbConfigCompatibility,
): RenderBoardConfig | undefined {
  // Woods sizes have distinct hold coordinates. Spray walls have per-wall slug identities.
  if (boardName === 'woods' || boardName === 'spray') return undefined;
  // The single-size MoonBoard layouts can render in full with all their sets.
  const fixedSize = boardName === 'moonboard';
  if (!fixedSize && (!compatibleSizeIds?.length || requiredSetIds == null)) return undefined;

  return catalogConfigs(boardName, layoutId).find(
    (config) =>
      (fixedSize || compatibleSizeIds?.includes(config.sizeId)) &&
      (requiredSetIds ?? []).every((setId) => config.setIds.includes(setId)),
  );
}
