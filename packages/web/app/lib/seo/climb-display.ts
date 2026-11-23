import { boardTypeLabel } from '@boardsesh/board-constants';
import { getSizesForLayoutId } from '@boardsesh/board-constants/catalog-metadata';
import type { BoardImageDetails } from '@/app/lib/board-image-details';

/** Keep the full V-grade first without dropping the Font grade. */
export function climbGradeForSearch(grade: string): string {
  const grades = grade
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);
  const vGrade = grades.find((part) => /^V\d+(?:[-+]?)$/i.test(part));
  if (!vGrade) return grade;
  const otherGrades = grades.filter((part) => part !== vGrade);
  return otherGrades.length ? `${vGrade} (${otherGrades.join('/')})` : vGrade;
}

/** Layout names frequently already contain the board brand. */
export function climbBoardForSearch(boardType: string, layoutName?: string | null): string {
  const board = boardTypeLabel(boardType);
  return layoutName
    ? layoutName.toLocaleLowerCase().includes(board.toLocaleLowerCase())
      ? layoutName
      : `${board} ${layoutName}`
    : board;
}

type BoardConfigNames = Pick<
  BoardImageDetails,
  'board_name' | 'layout_id' | 'size_id' | 'layout_name' | 'size_name' | 'size_description'
>;

type CatalogueSize = { id: number; name: string; description?: string | null };

/**
 * Tension spells a size height first ("10 high x 12 wide"); everything else, and
 * Tension's own product names, read width x height ("12x10").
 */
const HIGH_BY_WIDE = /(\d+)\s*high\s*x\s*(\d+)\s*wide/i;
const WIDTH_BY_HEIGHT = /(\d+)\s*x\s*(\d+)/i;

/** "12 x 12 with kickboard" → "12x12 with kickboard", "10 high x 12 wide" → "12x10". */
function compactDimensions(text: string): string {
  return text.replace(HIGH_BY_WIDE, '$2x$1').replace(WIDTH_BY_HEIGHT, '$1x$2').replace(/\s+/g, ' ').trim();
}

/** The size's dimensions alone ("12x12"), or its whole name when it has none ("Full Wall", "Master"). */
function sizeBaseLabel(size: CatalogueSize): string {
  const highByWide = HIGH_BY_WIDE.exec(size.name);
  if (highByWide) return `${highByWide[2]}x${highByWide[1]}`;
  const widthByHeight = WIDTH_BY_HEIGHT.exec(size.name);
  return widthByHeight ? `${widthByHeight[1]}x${widthByHeight[2]}` : size.name.trim();
}

/** What a reader tells same-dimension sizes apart by, in the order `sizeSlugsForLayout` tries them. */
const SIZE_QUALIFIERS: readonly ((size: CatalogueSize) => string)[] = [
  // Homewall's kits: "Mainline LED Kit" → "Mainline". Grasshopper's: "8 x 12 with Tweeners".
  (size) => compactDimensions((size.description ?? '').replace(/led\s*kit/gi, '')),
  // Kilter Original's two "Square" 12x12s differ only in their names: "with kickboard".
  (size) => compactDimensions(size.name.replace(HIGH_BY_WIDE, ' ').replace(WIDTH_BY_HEIGHT, ' ')),
];

/**
 * A board size as a reader names it, telling it apart from every other size on
 * its layout: "12x12" alone, "12x12 with kickboard" when the layout has two
 * 12x12s, "7x10 Mainline" when it has three LED kits at 7x10.
 *
 * Null for MoonBoard, whose every layout ships in one size the catalogue calls
 * "Standard", a word that tells a reader nothing.
 */
function boardSizeForSearch(board: BoardConfigNames): string | null {
  if (board.board_name === 'moonboard') return null;
  const sizesOnLayout: CatalogueSize[] = getSizesForLayoutId(board.board_name, board.layout_id);
  const ownSize =
    sizesOnLayout.find((size) => size.id === board.size_id) ??
    (board.size_name?.trim()
      ? { id: board.size_id, name: board.size_name, description: board.size_description }
      : null);
  if (!ownSize) return null;

  const base = sizeBaseLabel(ownSize);
  const sizesSharingBase = [ownSize, ...sizesOnLayout.filter((size) => size.id !== ownSize.id)].filter(
    (size) => sizeBaseLabel(size) === base,
  );
  if (sizesSharingBase.length === 1) return base;

  for (const qualifierOf of SIZE_QUALIFIERS) {
    const qualifiers = sizesSharingBase.map(qualifierOf);
    if (qualifiers.every(Boolean) && new Set(qualifiers).size === qualifiers.length) {
      return `${base} ${qualifierOf(ownSize)}`;
    }
  }
  return base;
}

/**
 * One board configuration named for a search title, layout then size:
 * "Kilter Board Original 12x12 with kickboard", "Tension Board 2 Mirror 12x10".
 * Without the size, every Kilter layout and size at one angle shared a single
 * title. Different hold sets on one layout and size still share a name.
 */
export function boardConfigForSearch(board: BoardConfigNames): string {
  // "Original Layout" is Tension's catalogue name for its first board; the URL slug drops "Layout" too.
  const layout = climbBoardForSearch(board.board_name, board.layout_name?.replace(/\s+layout$/i, ''));
  const size = boardSizeForSearch(board);
  return size ? `${layout} ${size}` : layout;
}
