import { getBoardLayouts, getBoardSetsForLayoutAndSize, getBoardSizesForLayoutId } from '@boardsesh/board-config';
import type { BoardName } from '@boardsesh/shared-schema';
import { GraphQLError } from 'graphql';

function unavailable(boardType: BoardName): never {
  throw new GraphQLError(
    boardType === 'spray'
      ? 'Spray walls have no static catalogue. Open the selected spray wall’s management page to edit its photo and holds.'
      : `Setup options are unavailable for ${boardType}. Choose a supported catalogue board type or retry after its catalogue is restored.`,
    { extensions: { code: 'BOARD_SETUP_OPTIONS_UNAVAILABLE' } },
  );
}

/** Use the same catalogue cascade as board setup, including code-defined boards. */
export function getGymBoardSetupOptions(boardType: BoardName) {
  const layouts = getBoardLayouts(boardType).map(({ id, name }) => ({ id, name }));
  const sizes: Record<string, { id: number; name: string; description: string }[]> = {};
  const sets: Record<string, { id: number; name: string }[]> = {};
  if (layouts.length === 0) unavailable(boardType);

  for (const layout of layouts) {
    const layoutSizes = getBoardSizesForLayoutId(boardType, layout.id);
    if (layoutSizes.length === 0) unavailable(boardType);
    sizes[`${boardType}-${layout.id}`] = layoutSizes.map(({ id, name, description }) => ({ id, name, description }));
    for (const size of layoutSizes) {
      const holdSets = getBoardSetsForLayoutAndSize(boardType, layout.id, size.id);
      if (holdSets.length === 0) unavailable(boardType);
      sets[`${boardType}-${layout.id}-${size.id}`] = holdSets.map(({ id, name }) => ({ id, name }));
    }
  }

  return { boardType, layouts, sizes, sets };
}
