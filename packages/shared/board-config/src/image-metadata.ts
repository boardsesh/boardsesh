import type { BoardName } from '@boardsesh/shared-schema';
import {
  PRODUCT_SIZES,
  getProductSize,
  getLayout,
  getSetsForLayoutAndSize,
  getImageFilename,
} from '@boardsesh/board-constants/catalog-metadata';
import { BOARD_IMAGE_DIMENSIONS } from './board-image-dimensions';
import { boardSupportsMirroring } from './board-mirroring';
import { toBoardName } from './board-name';
import {
  getLayoutById,
  getMoonBoardGeometry,
  MOONBOARD_SETS,
  MOONBOARD_SIZE,
  type MoonBoardLayoutKey,
} from './moonboard-metadata';
import { WOODS_GEOMETRY, WOODS_LAYOUTS, WOODS_SETS, WOODS_SIZES, woodsSizeIdToDimension } from './woods-metadata';

/** Presentation metadata for raster board art and canonical links, without hold geometry. */
export type BoardImageDetails = {
  board_name: BoardName;
  layout_id: number;
  size_id: number;
  set_ids: number[];
  layout_name?: string;
  size_name?: string;
  size_description?: string;
  set_names?: string[];
  boardWidth: number;
  boardHeight: number;
  backgroundImagePaths: string[];
  supportsMirroring?: boolean;
};

export type BoardImageDetailsParams = {
  board_name: string;
  layout_id: number;
  size_id: number;
  set_ids: number[];
};

/** Compute image metadata directly; never loads or computes per-hold placements. */
export function getBoardImageDetailsForBoard(params: BoardImageDetailsParams): BoardImageDetails {
  const { board_name, layout_id, size_id, set_ids } = params;
  if (board_name === 'moonboard') {
    const layoutEntry = getLayoutById(layout_id);
    if (!layoutEntry) throw new Error(`MoonBoard layout not found: ${layout_id}`);
    const [layoutKey, layout] = layoutEntry;
    const geometry = getMoonBoardGeometry(layoutKey as MoonBoardLayoutKey);
    const selectedSets = MOONBOARD_SETS[layoutKey as MoonBoardLayoutKey].filter((set) => set_ids.includes(set.id));
    return {
      board_name,
      layout_id,
      size_id: MOONBOARD_SIZE.id,
      set_ids,
      layout_name: layout.name,
      size_name: MOONBOARD_SIZE.name,
      size_description: MOONBOARD_SIZE.description,
      set_names: selectedSets.map((set) => set.name),
      boardWidth: geometry.width,
      boardHeight: geometry.height,
      backgroundImagePaths: [
        geometry.backgroundImage,
        ...selectedSets.map((set) => `${layout.folder}/${set.imageFile}`),
      ],
      supportsMirroring: false,
    };
  }
  if (board_name === 'woods') {
    const dimension = woodsSizeIdToDimension(size_id);
    if (!dimension) throw new Error(`Woods board size not found: ${size_id}`);
    const geometry = WOODS_GEOMETRY[dimension];
    return {
      board_name,
      layout_id: WOODS_LAYOUTS.woods.id,
      size_id,
      set_ids: WOODS_SETS.map((set) => set.id),
      layout_name: WOODS_LAYOUTS.woods.name,
      size_name: WOODS_SIZES[dimension].name,
      set_names: WOODS_SETS.map((set) => set.name),
      boardWidth: geometry.width,
      boardHeight: geometry.height,
      backgroundImagePaths: [geometry.backgroundImage],
      supportsMirroring: true,
    };
  }
  const boardName = toBoardName(board_name);
  const size = boardName ? getProductSize(boardName, size_id) : null;
  if (!boardName || !size) {
    const availableSizes = Object.keys((boardName && PRODUCT_SIZES[boardName]) || {});
    throw new Error(
      `Size dimensions not found for board_name=${board_name}, size_id=${size_id}. Available sizes: [${availableSizes.join(', ')}]`,
    );
  }
  const backgroundImagePaths = Array.from(
    new Set(
      set_ids.map((setId) => {
        const image = getImageFilename(boardName, layout_id, size_id, setId);
        if (!image)
          throw new Error(
            `Could not find image for set_id ${setId} for layout_id: ${layout_id} and size_id: ${size_id}`,
          );
        return image;
      }),
    ),
  );
  const dimensions = BOARD_IMAGE_DIMENSIONS[boardName][backgroundImagePaths[0]];
  return {
    board_name: boardName,
    layout_id,
    size_id,
    set_ids,
    layout_name: getLayout(boardName, layout_id)?.name,
    size_name: size.name,
    size_description: size.description,
    set_names: getSetsForLayoutAndSize(boardName, layout_id, size_id)
      .filter((set) => set_ids.includes(set.id))
      .map((set) => set.name),
    boardWidth: dimensions?.width ?? 1080,
    boardHeight: dimensions?.height ?? 1920,
    backgroundImagePaths,
    supportsMirroring: boardSupportsMirroring(boardName, layout_id),
  };
}

/** Explicit projection for server components that also need full board geometry. */
export function toBoardImageDetails(
  details: BoardImageDetails | (Omit<BoardImageDetails, 'backgroundImagePaths'> & { images_to_holds: object }),
): BoardImageDetails {
  return {
    board_name: details.board_name,
    layout_id: details.layout_id,
    size_id: details.size_id,
    set_ids: details.set_ids,
    layout_name: details.layout_name,
    size_name: details.size_name,
    size_description: details.size_description,
    set_names: details.set_names,
    boardWidth: details.boardWidth,
    boardHeight: details.boardHeight,
    backgroundImagePaths:
      'backgroundImagePaths' in details ? details.backgroundImagePaths : Object.keys(details.images_to_holds),
    supportsMirroring: details.supportsMirroring,
  };
}
