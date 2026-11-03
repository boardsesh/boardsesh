import { useContext, useMemo } from 'react';
import { BoardPresenceCurrentContext } from '@boardsesh/board-presence-react';
import type { BoardConnectionHolder } from '@boardsesh/shared-schema';
import { useOptionalBluetoothContext } from '../../providers/bluetooth-provider';
import { useBoardPresenceControls } from '../../providers/board-presence-provider';
import { useMoonboardRelayModeEnabled } from '../../providers/feature-flags-provider';
import { useQueueSessionControls } from '../../providers/queue-provider';
import { connectBlockedByRelayHolder, relayHolderFor } from '../../lib/board-relay/relay-holder';
import { isRelayPathSuppressed, useRelaySuppression } from '../../lib/board-relay/relay-path-store';

/**
 * Relay mode (#7220): the holder this phone lights the wall through, or null
 * for today's behaviour (`relayHolderFor`). Non-throwing outside the
 * providers, like `useBoardConnectionState`.
 *
 * The idle check reads the clock when an input changes, not on a timer: a
 * holder that goes idle while nothing else moves is caught at the next
 * presence event, and a relay to an idle-but-present holder still lands.
 */
export function useRelayHolder(): BoardConnectionHolder | null {
  const flagEnabled = useMoonboardRelayModeEnabled();
  const bluetooth = useOptionalBluetoothContext();
  const presence = useContext(BoardPresenceCurrentContext);
  const { boardId } = useBoardPresenceControls();
  const { sessionId, sessionMemberUserIds } = useQueueSessionControls();
  // Subscribed so a suppression re-renders; read through the pure check.
  useRelaySuppression();
  const holder = presence?.holder ?? null;
  const holderChangeSeq = presence?.lastHolderChangeSeq ?? 0;
  const suppressed = isRelayPathSuppressed(boardId, holderChangeSeq);
  const boardType = bluetooth?.boardName ?? null;
  const linkMode = bluetooth?.moonboardLinkMode?.mode ?? null;
  const localConnected = bluetooth?.isConnected ?? false;
  return useMemo(
    () =>
      relayHolderFor({
        flagEnabled,
        boardType,
        linkMode,
        holder: boardId === null ? null : holder,
        localConnected,
        sessionId,
        sessionMemberUserIds,
        suppressed,
        now: Date.now(),
      }),
    [flagEnabled, boardType, linkMode, boardId, holder, localConnected, sessionId, sessionMemberUserIds, suppressed],
  );
}

/**
 * Relay mode (#7220): the holder a connect from this phone would be blocked
 * by (`connectBlockedByRelayHolder`, as the notification bulb reads it), or
 * null when a connect goes ahead. The Lock Screen card and the Android
 * notification draw that board as held, never "Tap to reconnect". A
 * crewmate's hold counts, and this phone's own unreleased hold doesn't, as at
 * the tap.
 *
 * Like {@link useRelayHolder}, the idle clock is read when an input changes.
 * The tap itself still runs the gate fresh (`guardRelayConnect`).
 */
export function useRelayConnectBlocker(): BoardConnectionHolder | null {
  const flagEnabled = useMoonboardRelayModeEnabled();
  const bluetooth = useOptionalBluetoothContext();
  const presence = useContext(BoardPresenceCurrentContext);
  const { boardId } = useBoardPresenceControls();
  // Subscribed so a suppression re-renders; read through the pure check.
  useRelaySuppression();
  const holder = presence?.holder ?? null;
  const holderChangeSeq = presence?.lastHolderChangeSeq ?? 0;
  const suppressed = isRelayPathSuppressed(boardId, holderChangeSeq);
  const boardType = bluetooth?.boardName ?? null;
  const linkMode = bluetooth?.moonboardLinkMode?.mode ?? null;
  const localConnected = bluetooth?.isConnected ?? false;
  const lastLocalHolderUserId = bluetooth?.lastLocalHolderUserId ?? null;
  return useMemo(() => {
    const gate = connectBlockedByRelayHolder('notification', {
      flagEnabled,
      boardType,
      linkMode,
      holder: boardId === null ? null : holder,
      localConnected,
      suppressed,
      lastLocalHolderUserId,
      now: Date.now(),
    });
    return gate.blocked ? gate.holder : null;
  }, [flagEnabled, boardType, linkMode, boardId, holder, localConnected, suppressed, lastLocalHolderUserId]);
}
