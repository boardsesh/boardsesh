import { useContext, useMemo } from 'react';
import { BoardPresenceCurrentContext } from '@boardsesh/board-presence-react';
import { useOptionalBluetoothContext } from '../../providers/bluetooth-provider';
import { useBoardPresenceControls } from '../../providers/board-presence-provider';
import { useQueueSessionControls } from '../../providers/queue-provider';
import { deriveBoardConnection, type BoardConnection } from '../play-drawer/lightbulb-control';

export type BoardConnectionState = {
  /** The BLE context, or null when no board is selected yet. */
  bluetooth: ReturnType<typeof useOptionalBluetoothContext>;
  /** Whether THIS device holds the BLE link. */
  localConnected: boolean;
  /** A connect/disconnect is in flight. */
  pending: boolean;
  /** Current party session id (null when solo). */
  sessionId: string | null;
  /** Tri-state ownership; see {@link deriveBoardConnection}. */
  boardConnection: BoardConnection;
  /** Filled/lit visual: this device is driving, or a session peer is. */
  lit: boolean;
  /** Display name of the peer driving the wall (heldByPeer only), else null. */
  holderDisplayName: string | null;
};

/**
 * Single source of truth for board-connection ownership, shared by the in-app
 * lightbulb (`useLightbulbControl`) and the Live Activity bridge so the bulb on
 * the lock screen and in the app can never disagree. Pulls the same inputs
 * `deriveBoardConnection` needs from the bluetooth, board-presence, and session
 * providers.
 *
 * All reads are non-throwing where a caller might render before a provider
 * mounts (`useOptionalBluetoothContext`, the raw board-presence context, and the
 * no-op `useBoardPresenceControls` fallback); `useQueueSessionControls` is always
 * present under the tab tree.
 */
export function useBoardConnectionState(): BoardConnectionState {
  const bluetooth = useOptionalBluetoothContext();
  // Subscribed to the authoritative board-presence feed iff a board is bound.
  const { boardId } = useBoardPresenceControls();
  // Raw context (non-throwing) so a consumer rendered outside the provider
  // degrades to "no peer holder" instead of crashing.
  const boardPresenceCurrent = useContext(BoardPresenceCurrentContext);
  const { isSessionWallLit, sessionId, sessionMemberUserIds } = useQueueSessionControls();

  const localConnected = bluetooth?.isConnected ?? false;
  const pending = bluetooth?.loading ?? false;

  // The board-presence holder is board-scoped (anyone on this board feed). Tie it
  // to the session so we only treat it as a peer I'm climbing with: a logged-in
  // holder matches by userId; an anonymous holder falls back to the session
  // wall-lit flag (in a session only).
  const holder = boardPresenceCurrent?.holder ?? null;
  const holderUserId = holder?.userId ?? null;
  const sessionHolderPresent = sessionId !== null && holderUserId !== null && sessionMemberUserIds.has(holderUserId);
  const holderIsAnonymous = holder !== null && holderUserId === null && sessionId !== null;

  const boardConnection = deriveBoardConnection({
    localConnected,
    isSubscribedToBoardFeed: boardId !== null,
    sessionHolderPresent,
    holderIsAnonymous,
    isSessionWallLit,
  });

  // Only heldByPeer has a named "other" driver worth surfacing.
  const holderDisplayName = boardConnection === 'heldByPeer' ? (holder?.displayName ?? null) : null;

  return useMemo(
    () => ({
      bluetooth,
      localConnected,
      pending,
      sessionId,
      boardConnection,
      lit: boardConnection !== 'disconnected',
      holderDisplayName,
    }),
    [bluetooth, localConnected, pending, sessionId, boardConnection, holderDisplayName],
  );
}
