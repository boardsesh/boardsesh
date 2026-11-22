import { boardTypeLabel } from '@boardsesh/board-constants';

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

/**
 * A board size as a reader names it: "12 x 12 with kickboard" → "12x12".
 *
 * Null for MoonBoard, whose every layout ships in one size the catalogue calls
 * "Standard", a word that tells a reader nothing.
 */
function boardSizeForSearch(boardType: string, sizeName?: string | null): string | null {
  if (boardType === 'moonboard') return null;
  const trimmed = sizeName?.trim();
  if (!trimmed) return null;
  const dimensions = /(\d+)\s*x\s*(\d+)/i.exec(trimmed);
  return dimensions ? `${dimensions[1]}x${dimensions[2]}` : trimmed;
}

/**
 * One board configuration named for a search title, layout then size:
 * "Kilter Board Original 12x12". Without the size, every Kilter layout and size
 * at one angle shared a single title.
 */
export function boardConfigForSearch(board: {
  board_name: string;
  layout_name?: string | null;
  size_name?: string | null;
}): string {
  const layout = climbBoardForSearch(board.board_name, board.layout_name);
  const size = boardSizeForSearch(board.board_name, board.size_name);
  return size ? `${layout} ${size}` : layout;
}
