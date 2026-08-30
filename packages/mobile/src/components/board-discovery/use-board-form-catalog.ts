import { useEffect, useMemo } from 'react';
import { useAvailableCatalogBoards, useBoardCatalogReadiness } from '../../hooks/use-board-catalog';
import { useBoardAngleState } from '../../hooks/use-board-angle-state';
import { boardTypeLabel, cleanLayoutName } from './board-builder-labels';
import type { useBoardBuilder } from './use-board-builder';

type BoardFormCatalogSelection = Pick<
  ReturnType<typeof useBoardBuilder>,
  'boardName' | 'layoutId' | 'sizeId' | 'layouts' | 'setCatalogAngleOptions'
>;

/** Runtime catalogue adapters prepare labels, options and readiness together;
 * the form and the pure builder never need a downloaded board's model rules. */
export function useBoardFormCatalog({
  boardName,
  layoutId,
  sizeId,
  layouts,
  setCatalogAngleOptions,
}: BoardFormCatalogSelection) {
  const availableBoards = useAvailableCatalogBoards();
  const { geometryReady } = useBoardCatalogReadiness(boardName, layoutId, sizeId);
  const angleState = useBoardAngleState(boardName, { layoutId });
  useEffect(() => {
    setCatalogAngleOptions(angleState.requiresCatalog && angleState.ready ? angleState.angles : []);
  }, [layoutId, sizeId, angleState.requiresCatalog, angleState.ready, angleState.angles, setCatalogAngleOptions]);
  const boardOptions = useMemo(
    () =>
      availableBoards.map((board) => ({
        key: board,
        label: boardTypeLabel(board),
        value: board,
        selected: board === boardName,
      })),
    [availableBoards, boardName],
  );
  const layoutOptions = useMemo(
    () =>
      layouts.map((layout) => ({
        key: layout.id,
        label: cleanLayoutName(layout.name, boardName),
        value: layout.id,
        selected: layout.id === layoutId,
      })),
    [layouts, boardName, layoutId],
  );
  return {
    boardOptions,
    layoutOptions,
    geometryReady,
    requiresCatalogAngles: angleState.requiresCatalog,
    catalogAnglesLoading: angleState.loading,
  };
}
