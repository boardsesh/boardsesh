import { useContext, useMemo } from 'react';
import { BoardPresenceCurrentContext } from '@boardsesh/board-presence-react';
import { useOptionalBluetoothContext } from '../../providers/bluetooth-provider';
import { resolveWallHolderIdentity, type WallHolderIdentity } from './wall-holder-identity';

export type { WallHolderIdentity } from './wall-holder-identity';

/**
 * Who board presence names for the wall (#7000): the holder, or whoever put
 * the climb up. The same identity `useBoardDriver` reads, without its idle
 * clock, so the player doesn't re-render once a minute for a name.
 *
 * Presence only names someone. Whether their face goes on the board control
 * is the model's call (`resolveWallControl`), and it needs a live link.
 */
export function useWallHolderIdentity(): WallHolderIdentity {
  const current = useContext(BoardPresenceCurrentContext);
  // A crewmate just took the board from this phone (#7113 PR 4): until presence
  // names them, they stand in for the holder it still reports (this account, or
  // nobody once the release lands).
  const takenOverBy = useOptionalBluetoothContext()?.takenOverBy ?? null;
  const holder = current?.holder ?? null;
  const climb = current?.currentClimb ?? null;
  const identity = resolveWallHolderIdentity(holder, climb, takenOverBy);
  const { face, userId, holderUserId } = identity;
  const name = face?.name ?? null;
  const avatarUrl = face?.avatarUrl ?? null;
  return useMemo(
    () => ({ face: name === null && avatarUrl === null ? null : { name, avatarUrl }, userId, holderUserId }),
    [name, avatarUrl, userId, holderUserId],
  );
}
