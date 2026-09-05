import { useContext, useEffect, useMemo, useRef } from 'react';
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
  /**
   * A session peer holds the link per the AUTHORITATIVE board-presence holder —
   * server-owned and seq-gated, with a compare-and-delete broadcast on
   * disconnect and a WS-drop backstop. Deliberately excludes the `heldByPeer`
   * readings that come from the best-effort `isSessionWallLit` fallback, which
   * has no reconciliation and can stick `true`.
   *
   * Only this signal is allowed to suppress the lightbulb's connect
   * (`derivePlayDrawerLightbulbPressAction`): acting on the stuck-prone flag
   * would leave a climber unable to connect at all.
   */
  holderIsAuthoritative: boolean;
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
  // While THIS device holds the link, board presence names US the holder.
  // Remember which userId that was.
  const selfHeldUserIdRef = useRef<string | null>(null);
  // Forget the remembered self-hold when the board binding or the session changes. Without this the
  // memory outlives what it describes: after an account switch that doesn't
  // remount the tree, the previous account rejoining as a genuine PEER would
  // match its own remembered id and be read as our stale self — falling back to
  // the failed connect this PR removes (claude-review, #5123).
  useEffect(() => {
    selfHeldUserIdRef.current = null;
  }, [boardId, sessionId]);

  // Declared AFTER the reset on purpose: effects run in declaration order, so on
  // mount the reset lands first and this recorder gets the last word.
  useEffect(() => {
    if (localConnected && holderUserId != null) selfHeldUserIdRef.current = holderUserId;
  }, [localConnected, holderUserId]);

  // `sessionHolderPresent` is the authoritative half of heldByPeer; `&&
  // !localConnected` because my own hold outranks it (connectedByMe wins the
  // ladder, and the holder can be me).
  //
  // ...but a CLEARED local link does not clear the holder synchronously: the
  // release is a round-trip behind, and when the link DROPPED rather than being
  // handed over it may never land at all. Reading our own stale hold as "a peer
  // is driving" suppresses the very connect that would clear it, so the bulb
  // could stop reconnecting entirely (Fable + claude-review, PR #5123).
  //
  // A second device on the SAME ACCOUNT is indistinguishable from that stale
  // self by userId, so it lands here too and falls back to the plain connect.
  // Deliberate, and the safe way round: failing to relay costs one "Connection
  // failed", while failing to connect strands the climber off the board.
  const holderIsStaleSelf = !localConnected && holderUserId != null && holderUserId === selfHeldUserIdRef.current;
  const holderIsAuthoritative = sessionHolderPresent && !localConnected && !holderIsStaleSelf;

  return useMemo(
    () => ({
      bluetooth,
      localConnected,
      pending,
      sessionId,
      boardConnection,
      lit: boardConnection !== 'disconnected',
      holderDisplayName,
      holderIsAuthoritative,
    }),
    [bluetooth, localConnected, pending, sessionId, boardConnection, holderDisplayName, holderIsAuthoritative],
  );
}
