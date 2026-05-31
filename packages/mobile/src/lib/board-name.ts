import { SUPPORTED_BOARDS, type BoardName } from '@boardsesh/shared-schema';

const SUPPORTED_BOARD_SET: ReadonlySet<string> = new Set(SUPPORTED_BOARDS);

/**
 * Narrows a loose board string (e.g. `UserBoard.boardType` / a stored config,
 * both typed as plain `string`) to the `BoardName` union, or `null` when it is
 * empty / unknown. This is the single guard that keeps an unresolved board
 * (`''`, `undefined`) from flowing into a `boardType` API payload.
 */
export function toBoardName(value: string | null | undefined): BoardName | null {
  return value != null && SUPPORTED_BOARD_SET.has(value) ? (value as BoardName) : null;
}
