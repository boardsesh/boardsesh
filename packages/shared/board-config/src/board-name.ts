import { AURORA_BOARDS, SUPPORTED_BOARDS, type AuroraBoardName, type BoardName } from '@boardsesh/shared-schema';

// Validate against the SCHEMA list (not the MoonBoard-gated board-data list),
// so a board the API legitimately returns is accepted regardless of the
// platform's MoonBoard feature flag.
const SUPPORTED_BOARD_SET: ReadonlySet<string> = new Set(SUPPORTED_BOARDS);

export const MOONBOARD_BOARD_NAME = 'moonboard' satisfies BoardName;

/**
 * Narrows a loose board string (e.g. `UserBoard.boardType`, which the schema
 * types as plain `string`) to the `BoardName` union, or `null` when it is
 * empty / unknown. This is the single guard that keeps an unresolved board
 * (`''`, `undefined`) from flowing into a `boardType` API payload.
 */
export function toBoardName(value: string | null | undefined): BoardName | null {
  return value != null && SUPPORTED_BOARD_SET.has(value) ? (value as BoardName) : null;
}

const AURORA_BOARD_SET: ReadonlySet<string> = new Set(AURORA_BOARDS);

/**
 * Narrows a loose board string to the `AuroraBoardName` union, or `null` for a
 * code-driven board (MoonBoard, Woods) or an unknown name. The partner of
 * `getBoardCapabilities(...).auroraAppLink`: the capability decides whether an
 * Aurora-only surface is offered at all, this turns the string into the type
 * that surface's helpers assume.
 */
export function toAuroraBoardName(value: string | null | undefined): AuroraBoardName | null {
  return value != null && AURORA_BOARD_SET.has(value) ? (value as AuroraBoardName) : null;
}

/**
 * Whether a loose board-name value identifies Boardsesh's canonical MoonBoard
 * board type. This is intentionally distinct from BLE device-name detection:
 * advertised peripheral names have prefixes such as `MoonBoard A`, while app
 * board names use the schema's lowercase `moonboard` identifier.
 */
export function isMoonboardBoardName(boardName: string | null | undefined): boardName is typeof MOONBOARD_BOARD_NAME {
  return boardName === MOONBOARD_BOARD_NAME;
}

/**
 * Whether a board type's climbs are scoped by product size. MoonBoard has a single
 * fixed size, so its climbs are never size-filtered; every other board has size
 * variants (compatible_size_ids). One source of truth for the `!== 'moonboard'`
 * size-scoping guard shared by the sync resolvers, the offline local search, and
 * the offline download-availability check.
 */
export function isSizeScopedBoard(boardType: string): boolean {
  return !isMoonboardBoardName(boardType);
}

/**
 * Trademark-safe display name for a board type (e.g. `kilter` → "Kilter",
 * `moonboard` → "MoonBoard", `soill` → "So iLL"). Lives here so both web
 * (`@/app/lib/string-utils`) and shared packages (`@boardsesh/profile-stats`)
 * share one source of truth for board-name casing.
 */
export function formatBoardDisplayName(boardType: string): string {
  if (boardType === 'moonboard') return 'MoonBoard';
  if (boardType === 'soill') return 'So iLL';
  return boardType.charAt(0).toUpperCase() + boardType.slice(1);
}
