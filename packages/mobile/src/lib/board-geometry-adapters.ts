import type { BoardName } from '@boardsesh/shared-schema';
import { ensureSprayWallLoaded, sprayCacheToken, subscribeToSprayWalls } from './spray/spray-wall-registry';

export type BoardGeometryConfig = { boardName: BoardName; layoutId: number; sizeId: number };

type BoardGeometryAdapter = {
  version: (config: BoardGeometryConfig) => string;
  subscribe: (listener: () => void) => () => void;
  ensureLoaded?: (config: BoardGeometryConfig) => void;
};

const ignoreGeometryChanges = () => () => {};
const bundledGeometry: BoardGeometryAdapter = { version: () => 'static', subscribe: ignoreGeometryChanges };
const runtimeGeometry: Partial<Record<BoardName, BoardGeometryAdapter>> = {
  spray: {
    version: ({ layoutId }) => sprayCacheToken('spray', layoutId),
    subscribe: subscribeToSprayWalls,
    ensureLoaded: ({ layoutId }) => ensureSprayWallLoaded(layoutId),
  },
};

function geometryAdapter(boardName: BoardName): BoardGeometryAdapter {
  return runtimeGeometry[boardName] ?? bundledGeometry;
}

export function getBoardGeometryVersion(config: BoardGeometryConfig): string {
  return geometryAdapter(config.boardName).version(config);
}

export function subscribeBoardGeometry(boardName: BoardName | undefined, listener: () => void): () => void {
  return boardName ? geometryAdapter(boardName).subscribe(listener) : ignoreGeometryChanges();
}

export function ensureBoardGeometryLoaded(config: BoardGeometryConfig): void {
  geometryAdapter(config.boardName).ensureLoaded?.(config);
}
