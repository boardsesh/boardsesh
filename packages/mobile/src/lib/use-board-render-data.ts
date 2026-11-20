import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { getBoardRenderData, type BoardRenderConfig, type BoardRenderInput } from './board-details';
import { getCreateBoardHolds } from './create-board-holds';
import { ensureBoardGeometryLoaded, getBoardGeometryVersion, subscribeBoardGeometry } from './board-geometry-adapters';
import { parseSetIds } from './board-presence/parse-set-ids';

type ResolvedBoardGeometryConfig = BoardRenderConfig & { geometryVersion: string };

/** One reactive config identity for bundled and runtime board geometry. */
function useBoardGeometryConfig(request: BoardRenderInput | null): ResolvedBoardGeometryConfig | null {
  const boardName = request?.boardName;
  const layoutId = request?.layoutId ?? 0;
  const sizeId = request?.sizeId ?? 0;
  const setIdsWire = request ? (typeof request.setIds === 'string' ? request.setIds : request.setIds.join(',')) : '';
  const subscribe = useCallback((listener: () => void) => subscribeBoardGeometry(boardName, listener), [boardName]);
  const snapshot = useCallback(
    () => (boardName ? getBoardGeometryVersion({ boardName, layoutId, sizeId }) : 'disabled'),
    [boardName, layoutId, sizeId],
  );
  const geometryVersion = useSyncExternalStore(subscribe, snapshot, snapshot);

  useEffect(() => {
    if (boardName) ensureBoardGeometryLoaded({ boardName, layoutId, sizeId });
  }, [boardName, layoutId, sizeId, geometryVersion]);

  return useMemo(() => {
    if (!boardName) return null;
    const setIds = parseSetIds(setIdsWire);
    if (setIds.length === 0) return null;
    // The version is observable input, not only an extra memo dependency: Expo's
    // React Compiler may drop a dependency the computed object never reads.
    return { boardName, layoutId, sizeId, setIds, geometryVersion };
  }, [boardName, layoutId, sizeId, setIdsWire, geometryVersion]);
}

/** The same normalized render shape for every board; null until usable. */
export function useBoardRenderData(request: BoardRenderInput | null) {
  const config = useBoardGeometryConfig(request);
  return useMemo(() => (config ? getBoardRenderData(config) : null), [config]);
}

/** Tappable holds follow the same geometry arrival, replacement and removal. */
export function useCreateBoardHolds(request: BoardRenderInput | null) {
  const config = useBoardGeometryConfig(request);
  return useMemo(() => (config ? getCreateBoardHolds(config) : null), [config]);
}
