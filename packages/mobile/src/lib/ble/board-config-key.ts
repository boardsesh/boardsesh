// Identity of a board pairing: the silent-reconnect and adoption guards only
// trust a remembered/native connection while the active board still matches.
// Deliberately excludes set_ids — see the reconnectSerialForCurrentBoard note in
// use-board-bluetooth.ts.
//
// The board uuid IS included, for a different reason than sets. Sets are about
// which encoding the wall needs; the uuid is about WHICH BOX. A gym can run two
// identically-configured walls, and without the uuid a serial remembered against
// one of them is silently offered as the reconnect target for the other — the
// lightbulb lights the wall the climber just walked away from. A missing uuid
// contributes an empty segment, which is stable and matches the old key shape.
//
// Records persisted under the old key simply stop matching after an upgrade and
// fall back to the device picker, so no migration is needed.
export function boardConfigKey(
  boardName: string,
  layoutId: number,
  sizeId: number,
  boardUuid: string | undefined,
): string {
  return `${boardName}::${layoutId}::${sizeId}::${boardUuid ?? ''}`;
}
