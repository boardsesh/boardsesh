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

/** Hebrew, Arabic, Syriac, Thaana, NKo and their presentation forms. */
const RIGHT_TO_LEFT_TEXT = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
const FIRST_STRONG_ISOLATE = '\u2068';
const POP_DIRECTIONAL_ISOLATE = '\u2069';

/**
 * Wrap a climber-typed name in a Unicode isolate when it carries right-to-left
 * text. Unwrapped, a name ending in Hebrew or Arabic pulls the " • 40°" that
 * follows it into its own run, and the angle lands on the wrong side of the
 * title or is cut off with it (#5960). Left-to-right names stay byte-identical.
 */
function isolateDirection(name: string): string {
  return RIGHT_TO_LEFT_TEXT.test(name) ? `${FIRST_STRONG_ISOLATE}${name}${POP_DIRECTIONAL_ISOLATE}` : name;
}

export function formatActiveBoardLabel(
  activeBoard: BoardLabelFields | null | undefined,
  { includeAngle = true }: BoardLabelOptions = {},
): string | null {
  if (!activeBoard) return null;

  const angleLabel = includeAngle && activeBoard.angle != null ? `${activeBoard.angle}°` : null;
  const customName = activeBoard.name?.trim();
  const hasCustomName = customName != null && customName.length > 0;
  const labelParts = hasCustomName
    ? [isolateDirection(customName), angleLabel]
    : [
        formatBoardDisplayName(activeBoard.boardType),
        activeBoard.sizeName ?? activeBoard.layoutName ?? null,
        angleLabel,
      ];

  return labelParts.filter(Boolean).join(' • ');
}
