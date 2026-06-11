export const GUEST_BOARD_UUID_PREFIX = 'guest-board:';

export function isGuestActiveBoard(board: { uuid?: string | null } | null | undefined): boolean {
  return typeof board?.uuid === 'string' && board.uuid.startsWith(GUEST_BOARD_UUID_PREFIX);
}
