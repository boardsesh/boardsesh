import type { BoardHandoffRequester } from '@boardsesh/shared-schema';
import type { WallControlFace } from './wall-control';

export type WallHolderIdentity = {
  /** Who board presence says holds the board, or put its climb up. Null when nobody is known. */
  face: WallControlFace | null;
  userId: string | null;
  /** Presence's named holder only, without the climb's sender: who holds the link, as far as presence knows. */
  holderUserId: string | null;
};

type PresenceHolder = { userId?: string | null; displayName?: string | null; avatarUrl?: string | null };
type PresenceClimbSender = {
  sentByUserId?: string | null;
  sentByDisplayName?: string | null;
  sentByAvatarUrl?: string | null;
};

/**
 * Who the board control names: presence's holder, else whoever put the climb
 * up. While a crewmate's hand-off is on its way (`takenOverBy`), that crewmate
 * instead: presence then still names this account or nobody (it clears once
 * presence names anyone else), so the control reads "Put on board" with their
 * face, never "On your other phone", and never this climber's own name off the
 * climb they lit.
 */
export function resolveWallHolderIdentity(
  holder: PresenceHolder | null,
  climb: PresenceClimbSender | null,
  takenOverBy: BoardHandoffRequester | null,
): WallHolderIdentity {
  if (takenOverBy) {
    const name = takenOverBy.displayName ?? null;
    const avatarUrl = takenOverBy.avatarUrl ?? null;
    return {
      face: name === null && avatarUrl === null ? null : { name, avatarUrl },
      userId: takenOverBy.userId,
      holderUserId: takenOverBy.userId,
    };
  }
  const name = holder?.displayName ?? climb?.sentByDisplayName ?? null;
  const avatarUrl = holder?.avatarUrl ?? climb?.sentByAvatarUrl ?? null;
  const holderUserId = holder?.userId ?? null;
  return {
    face: name === null && avatarUrl === null ? null : { name, avatarUrl },
    userId: holderUserId ?? climb?.sentByUserId ?? null,
    holderUserId,
  };
}
