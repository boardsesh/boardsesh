import type { BoardConnectionHolder } from '@boardsesh/shared-schema';
import type { LiveActivityBoardRelay } from '../../../modules/live-activity/src/index';
import type { BoardConnection } from '../../components/play-drawer/lightbulb-control';
import { relayHolderNameOf } from '../board-relay/relay-holder';

/**
 * Relay mode (#7220): what the Lock Screen card and the Android notification
 * are told about the board, from the JS rules (`relayHolderFor` and
 * `connectBlockedByRelayHolder`). Native never works the holder rule out for
 * itself; it draws what this says.
 *
 * The connection value keeps its three meanings on the wire, the ones every
 * installed binary and the backend's APNs push know. Relay rides beside it in
 * `boardRelay`:
 *
 * - This phone's own link holds the board: unchanged, no relay.
 * - This phone relays through the holder (`relayHolder`): `heldByPeer` with
 *   the holder's name, and `relaying`. A binary that knows `boardRelay` shows
 *   Previous / Next and hands each press to JS; one that doesn't draws the
 *   held card, never "Tap to reconnect".
 * - A connect would only scan for nothing (`blockingHolder`): `heldByPeer`
 *   and `blocked`. A crewmate's hold is already `heldByPeer`; a stranger's
 *   used to read `disconnected` and offer a reconnect the box can't take.
 * - Otherwise unchanged, and `boardRelay` null so native clears what it kept.
 *
 * `boardConnection` is the BLE-only value (`deriveBoardConnection`). Widget
 * navigation stays gated on that raw value, so a binary without relay never
 * arms Bluetooth Next / Previous on a phone with no link.
 */
export type LiveActivityBoardPresence = {
  boardConnection: BoardConnection;
  holderDisplayName: string | null;
  boardRelay: LiveActivityBoardRelay | null;
};

export function deriveLiveActivityBoardPresence({
  boardConnection,
  holderDisplayName,
  relayHolder,
  blockingHolder,
}: {
  /** The BLE-only tri-state (`deriveBoardConnection`). */
  boardConnection: BoardConnection;
  /** The holder's name the in-app surfaces already show for `heldByPeer`. */
  holderDisplayName: string | null;
  /** The holder this phone lights climbs through (`relayHolderFor`), or null. */
  relayHolder: BoardConnectionHolder | null;
  /** The holder a connect here would be blocked by (`connectBlockedByRelayHolder`), or null. */
  blockingHolder: BoardConnectionHolder | null;
}): LiveActivityBoardPresence {
  if (boardConnection === 'connectedByMe') {
    return { boardConnection, holderDisplayName: null, boardRelay: null };
  }
  if (relayHolder) {
    return { boardConnection: 'heldByPeer', holderDisplayName: relayHolderNameOf(relayHolder), boardRelay: 'relaying' };
  }
  if (blockingHolder) {
    return {
      boardConnection: 'heldByPeer',
      holderDisplayName:
        boardConnection === 'heldByPeer' && holderDisplayName ? holderDisplayName : relayHolderNameOf(blockingHolder),
      boardRelay: 'blocked',
    };
  }
  return { boardConnection, holderDisplayName, boardRelay: null };
}
