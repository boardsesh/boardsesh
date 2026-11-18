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
