import { useContext, useMemo } from 'react';
import { BoardPresenceCurrentContext } from '@boardsesh/board-presence-react';
import type { WallControlFace } from './wall-control';

export type WallHolderIdentity = {
  /** Who board presence says holds the board, or put its climb up. Null when nobody is known. */
  face: WallControlFace | null;
  userId: string | null;
};

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
  const holder = current?.holder ?? null;
  const climb = current?.currentClimb ?? null;
  const name = holder?.displayName ?? climb?.sentByDisplayName ?? null;
  const avatarUrl = holder?.avatarUrl ?? climb?.sentByAvatarUrl ?? null;
  const userId = holder?.userId ?? climb?.sentByUserId ?? null;
  return useMemo(
    () => ({ face: name === null && avatarUrl === null ? null : { name, avatarUrl }, userId }),
    [name, avatarUrl, userId],
  );
}
