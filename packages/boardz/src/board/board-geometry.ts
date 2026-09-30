import type { BoardName } from '@boardsesh/shared-schema';
import {
  BOARD_IMAGE_DIMENSIONS,
  MOONBOARD_SIZE,
  getMoonBoardDetails,
  getMoonBoardGeometryByLayoutId,
  getWoodsBoardDetails,
} from '@boardsesh/board-config';
import { HOLD_STATE_MAP, toFlatFrames } from '@boardsesh/board-constants/hold-states';
import { getHolePlacements, getImageFilename, getProductSize } from '@boardsesh/board-constants/product-sizes';
import type { ActiveBoard } from './active-board';

export type HoldPosition = { cx: number; cy: number; r: number };

export type HoldRole = 'start' | 'hand' | 'foot' | 'finish';

/** A MoonBoard's hold grid: where it sits in the art, and its columns and rows. */
export type BoardGrid = {
  /** The grid's rectangle in image pixels. The panel shows just this. */
  crop: { x: number; y: number; width: number; height: number };
  columns: number;
  /** Row numbers run from `rowTop` at the top down to 1 (Minis stop at 12). */
  rowTop: number;
};

export type BoardGeometry = {
  /** Board photo size in pixels; hold positions use the same space. */
  width: number;
  height: number;
  /** Photo layers, bottom first, as paths under the website's /images/. */
  imagePaths: string[];
  holds: Map<number, HoldPosition>;
  /** Present for MoonBoards, which have lettered columns and numbered rows. */
  grid: BoardGrid | null;
};

export type LitHold = HoldPosition & { id: number; role: HoldRole };

type GeometryBoard = Pick<ActiveBoard, 'boardName' | 'layoutId' | 'sizeId' | 'setIds'>;

// Photos are served as .webp next to the .png names the catalogue uses.
const toWebp = (filename: string) => filename.replace(/\.png$/, '.webp');

function moonboardGeometry({ layoutId, sizeId, setIds }: GeometryBoard): BoardGeometry | null {
  if (sizeId !== MOONBOARD_SIZE.id) return null;
  let details: ReturnType<typeof getMoonBoardDetails>;
  try {
    details = getMoonBoardDetails({ layout_id: layoutId, set_ids: setIds });
  } catch {
    return null;
  }
  const gridGeometry = getMoonBoardGeometryByLayoutId(layoutId);
  const { leftMargin, rightMargin, topMargin, bottomMargin } = gridGeometry.calibration;
  const width = details.boardWidth;
  const height = details.boardHeight;
  return {
    width,
    height,
    // The background art is a white canvas with printed labels, made for a
    // light page. Boardz draws its own dark panel and labels instead.
    imagePaths: Object.keys(details.images_to_holds)
      .filter((filename) => filename !== gridGeometry.backgroundImage)
      .map((filename) => `moonboard/${toWebp(filename)}`),
    holds: new Map(details.holdsData.map((hold) => [hold.id, { cx: hold.cx, cy: hold.cy, r: hold.r }])),
    grid: {
      crop: {
        x: leftMargin * width,
        y: topMargin * height,
        width: (1 - leftMargin - rightMargin) * width,
        height: (1 - topMargin - bottomMargin) * height,
      },
      columns: gridGeometry.numColumns,
      rowTop: gridGeometry.rowTop,
    },
  };
}

function woodsGeometry({ sizeId }: GeometryBoard): BoardGeometry | null {
  let details: ReturnType<typeof getWoodsBoardDetails>;
  try {
    details = getWoodsBoardDetails({ size_id: sizeId });
  } catch {
    return null;
  }
  return {
    width: details.boardWidth,
    height: details.boardHeight,
    // The art is the holds cut out on transparency, and its dark cut is made for
    // a dark background like the panel.
    imagePaths: Object.keys(details.images_to_holds).map(
      (filename) => `woods/${filename.replace(/\.png$/, '.dark.webp')}`,
    ),
    holds: new Map(details.holdsData.map((hold) => [hold.id, { cx: hold.cx, cy: hold.cy, r: hold.r }])),
    grid: null,
  };
}

// Same maths as Boardsesh's getBoardDetails: catalogue coordinates, cropped to
// the size's edges, scaled onto the photo with y flipped.
function auroraGeometry({ boardName, layoutId, sizeId, setIds }: GeometryBoard): BoardGeometry | null {
  const size = getProductSize(boardName, sizeId);
  if (!size) return null;
  const { edgeLeft, edgeRight, edgeBottom, edgeTop } = size;

  const imageFilenames: string[] = [];
  const holdTuples: Array<[number, number | null, number, number]> = [];
  for (const setId of setIds) {
    const filename = getImageFilename(boardName, layoutId, sizeId, setId);
    if (!filename) continue;
    imageFilenames.push(filename);
    holdTuples.push(...getHolePlacements(boardName, layoutId, setId));
  }
  if (imageFilenames.length === 0) return null;

  const dimensions = BOARD_IMAGE_DIMENSIONS[boardName]?.[imageFilenames[0]];
  const width = dimensions?.width ?? 1080;
  const height = dimensions?.height ?? 1920;
  const xSpacing = width / (edgeRight - edgeLeft);
  const ySpacing = height / (edgeTop - edgeBottom);

  const holds = new Map<number, HoldPosition>();
  for (const [holdId, , x, y] of holdTuples) {
    if (x <= edgeLeft || x >= edgeRight || y <= edgeBottom || y >= edgeTop) continue;
    holds.set(holdId, { cx: (x - edgeLeft) * xSpacing, cy: height - (y - edgeBottom) * ySpacing, r: xSpacing * 4 });
  }

  return {
    width,
    height,
    imagePaths: imageFilenames.map((filename) => `${boardName}/${toWebp(filename)}`),
    holds,
    grid: null,
  };
}

const geometryCache = new Map<string, BoardGeometry | null>();

/** Photo layers and hold positions for a board configuration. Cached: the catalogue never changes. */
export function getBoardGeometry(board: GeometryBoard): BoardGeometry | null {
  const key = `${board.boardName}:${board.layoutId}:${board.sizeId}:${board.setIds.join(',')}`;
  const cached = geometryCache.get(key);
  if (cached !== undefined) return cached;
  const geometry =
    board.boardName === 'moonboard'
      ? moonboardGeometry(board)
      : board.boardName === 'woods'
        ? woodsGeometry(board)
        : auroraGeometry(board);
  geometryCache.set(key, geometry);
  return geometry;
}

const ROLE_BY_STATE: Partial<Record<string, HoldRole>> = {
  STARTING: 'start',
  HAND: 'hand',
  FINISH: 'finish',
  FOOT: 'foot',
  // Rarer states still light up; they read as hands.
  ANY: 'hand',
  AUX: 'hand',
};

/** The holds a climb uses, placed on the board with their role (start, hand, foot, finish). */
export function litHolds(geometry: BoardGeometry, boardName: BoardName, frames: string): LitHold[] {
  const states = HOLD_STATE_MAP[boardName];
  const lit: LitHold[] = [];
  for (const placement of toFlatFrames(frames, boardName).split('p')) {
    if (!placement) continue;
    const [holdId, roleCode] = placement.split('r').map(Number);
    const role = ROLE_BY_STATE[states[roleCode]?.name ?? ''];
    const position = geometry.holds.get(holdId);
    if (!role || !position) continue;
    lit.push({ id: holdId, ...position, role });
  }
  return lit;
}
