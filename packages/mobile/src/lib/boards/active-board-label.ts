import { formatBoardDisplayName } from '@boardsesh/board-config';

type BoardLabelFields = {
  name?: string | null;
  angle?: number | null;
  boardType: string;
  sizeName?: string | null;
  layoutName?: string | null;
};

type BoardLabelOptions = {
  /** Append the angle segment (e.g. "• 40°"). Default true. Set false where the
   *  angle is surfaced separately (the Material board switcher — the angle rides
   *  its own filter chip), to avoid showing it twice. */
  includeAngle?: boolean;
};

export function formatActiveBoardLabel(
  activeBoard: BoardLabelFields | null | undefined,
  { includeAngle = true }: BoardLabelOptions = {},
): string | null {
  if (!activeBoard) return null;

  const angleLabel = includeAngle && activeBoard.angle != null ? `${activeBoard.angle}°` : null;
  const customName = activeBoard.name?.trim();
  const hasCustomName = customName != null && customName.length > 0;
  const labelParts = hasCustomName
    ? [customName, angleLabel]
    : [
        formatBoardDisplayName(activeBoard.boardType),
        activeBoard.sizeName ?? activeBoard.layoutName ?? null,
        angleLabel,
      ];

  return labelParts.filter(Boolean).join(' • ');
}
