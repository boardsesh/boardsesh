import type { UserBoard } from '@boardsesh/shared-schema';

/**
 * A board's uuid, or null when it has none.
 *
 * An anonymous serial lookup on a hidden board returns its geometry only: an
 * empty `uuid` and `slug`, a null `boardId` and the board type as its name
 * (#6375). That empty string is not a board, and never a link. Read it as "no
 * uuid" everywhere a uuid would be sent, followed, bound or keyed on.
 */
export function boardUuidOrNull(uuid: string | null | undefined): string | null {
  return uuid ? uuid : null;
}

type BoardRowIdentity = Pick<UserBoard, 'uuid' | 'boardType' | 'layoutId' | 'sizeId' | 'setIds' | 'angle'> & {
  serialNumber?: string | null;
};

/**
 * One React key per board row, unique within the list.
 *
 * A board with a uuid keys on it. A geometry-only row (a hidden board found by
 * its serial) has an empty uuid, so two of them would share the key `''`; it
 * keys on its serial and config instead. Two hidden boards can still share a
 * serial and config, so a repeat gets its position appended.
 */
export function boardRowKeys(boards: ReadonlyArray<BoardRowIdentity>): string[] {
  const seen = new Map<string, number>();
  return boards.map((board) => {
    const uuid = boardUuidOrNull(board.uuid);
    const baseKey =
      uuid ??
      `geometry:${board.serialNumber ?? ''}:${board.boardType}:${board.layoutId}:${board.sizeId}:${board.setIds}:${board.angle}`;
    const repeats = seen.get(baseKey) ?? 0;
    seen.set(baseKey, repeats + 1);
    return repeats === 0 ? baseKey : `${baseKey}#${repeats}`;
  });
}
