import { formatBoardDisplayName } from '@boardsesh/board-config';

type BoardLabelFields = {
  name?: string | null;
  angle?: number | null;
  boardType: string;
  sizeName?: string | null;
  layoutName?: string | null;
};

export function formatActiveBoardLabel(activeBoard: BoardLabelFields | null | undefined): string | null {
  if (!activeBoard) return null;

  const angleLabel = activeBoard.angle != null ? `${activeBoard.angle}°` : null;
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
