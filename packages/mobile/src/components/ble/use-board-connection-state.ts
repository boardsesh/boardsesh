import { useContext, useMemo } from 'react';
import { BoardPresenceCurrentContext } from '@boardsesh/board-presence-react';
import { useOptionalBluetoothContext } from '../../providers/bluetooth-provider';
import { useBoardPresenceControls } from '../../providers/board-presence-provider';
import { useQueueSessionControls } from '../../providers/queue-provider';
import {
  deriveBoardConnection,
  deriveInAppBoardConnection,
  type BoardConnection,
} from '../play-drawer/lightbulb-control';

export type BoardConnectionState = {
  /** The BLE context, or null when no board is selected yet. */
  bluetooth: ReturnType<typeof useOptionalBluetoothContext>;
  /** Whether THIS device holds the BLE link. */
  localConnected: boolean;
  /** A connect/disconnect is in flight. */
  pending: boolean;
  /** Current party session id (null when solo). */
  sessionId: string | null;
  /**
   * Tri-state ownership as the Live Activity sees it — BLE only. Never widened
   * by a virtual hold; see {@link deriveBoardConnection}.
   */
  boardConnection: BoardConnection;
  /**
   * Tri-state ownership as the IN-APP surfaces see it: the BLE value, widened by
   * a virtual hold on a wall with no lights. See {@link deriveInAppBoardConnection}.
   */
  inAppBoardConnection: BoardConnection;
  /** The active board is flagged as having no LED light kit. */
  ledless: boolean;
  /** This device holds the wall with no Bluetooth link. */
  wallHeldLocally: boolean;
  /** The server's holder slot belongs to a different signed-in user. */
  wallHeldByOtherUser: boolean;
  /** Either transport can put a climb on the wall right now. */
  canDriveWall: boolean;
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
  const ledless = bluetooth?.ledless ?? false;
  const wallHeldLocally = bluetooth?.virtualWallHeld ?? false;
  const wallHeldByOtherUser = bluetooth?.wallHeldByOtherUser ?? false;
  const canDriveWall = bluetooth?.canDriveWall ?? false;

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

  // What the in-app bulb, the queue bar and the capsule read. The Live Activity
  // and the native iOS intents keep reading the BLE-only `boardConnection`, so a
  // virtual hold can never light the lock screen or arm widget navigation.
  const inAppBoardConnection = deriveInAppBoardConnection({
    boardConnection,
    wallHeld: wallHeldLocally,
    wallHeldByOtherUser,
  });

  // Only heldByPeer has a named "other" driver worth surfacing.
  const holderDisplayName = inAppBoardConnection === 'heldByPeer' ? (holder?.displayName ?? null) : null;

  return useMemo(
    () => ({
      bluetooth,
      localConnected,
      pending,
      sessionId,
      boardConnection,
      inAppBoardConnection,
      ledless,
      wallHeldLocally,
      wallHeldByOtherUser,
      canDriveWall,
      lit: inAppBoardConnection !== 'disconnected',
      holderDisplayName,
    }),
    [
      bluetooth,
      localConnected,
      pending,
      sessionId,
      boardConnection,
      inAppBoardConnection,
      ledless,
      wallHeldLocally,
      wallHeldByOtherUser,
      canDriveWall,
      holderDisplayName,
    ],
  );
}
