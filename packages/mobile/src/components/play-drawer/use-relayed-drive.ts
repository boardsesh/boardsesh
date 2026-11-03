import { useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { BoardPresenceCurrentContext } from '@boardsesh/board-presence-react';
import type { ClimbQueueItem } from '@boardsesh/queue';
import { useBoardPresenceControls } from '../../providers/board-presence-provider';
import { useOptionalBluetoothContext } from '../../providers/bluetooth-provider';
import { useActiveClimbUuid, useQueueActions } from '../../providers/queue-provider';
import { announceQueued } from '../../lib/announce-queued';
import { hapticSuccess, hapticWarning } from '../../lib/haptics';
import { toClimbInput } from '../../lib/climb-to-queue-item';
import { subscribeRelayEchoes } from '../../lib/board-relay/relay-bus';
import { relayHolderKeyOf, relayHolderNameOf, resolveRelayedDriveHolderExit } from '../../lib/board-relay/relay-holder';
import {
  disengageRelayPath,
  engageRelayPath,
  registerRelayRunner,
  suppressRelayPath,
  useEngagedRelayPath,
} from '../../lib/board-relay/relay-path-store';
import { createRelaySender, mintRelayRequestId, type RelayOutcome } from '../../lib/board-relay/relay-sender';
import { driveEndSupersedesRelay, relayOutcomeEffect } from './relay-outcome';
import { useRelayHolder } from '../ble/use-relay-holder';
import {
  clearDrivingStopped,
  exitDriveMode,
  getDriveMode,
  markDriveLive,
  noteDriveClimbLit,
  subscribeDriveEnded,
  useDriveMode,
  type DriveModeState,
} from './drive-mode-store';
import {
  claimRelayLostPath,
  clearRelayLost,
  formatRelayLost,
  showRelayLost,
  type RelayLostNotice,
} from './relay-lost-store';
import { spokenCaption } from './track-label-text';

/** Who a relay went to and which lost-path episode it belongs to (a drive, or one press). */
type RelaySendContext = {
  boardId: number;
  holderKey: string;
  holderName: string | null;
  episode: string;
};

function queueItemToRelayInput(item: ClimbQueueItem) {
  return { uuid: item.uuid, climb: toClimbInput(item.climb) };
}

/**
 * Relay mode (#7220), the relaying phone: everything that lights an original
 * MoonBoard through the phone that holds it. Mounted once, by
 * `BoardRelayWatcher` at the app root, so it holds with the player closed.
 *
 * - Registers the relay runner (`relayClimbThroughHolder`) that Put on board,
 *   the bulbs and the drive use: one climb to the holder with a fresh
 *   `relayRequestId`, confirmed by the holder's `BoardClimbSet` echoing it
 *   within `RELAY_CONFIRM_TIMEOUT_MS`.
 * - Follows a relayed drive: an arming drive relays the current climb (a
 *   press's own relay of the same climb is joined, not sent twice), and every
 *   change of current climb relays the new one. Always drive the wall's drive
 *   starts live and relays only the picks after it.
 * - Watches the holder: during a relayed drive, presence clearing the holder
 *   ends it `holder_left`, and another phone taking it ends it
 *   `holder_changed`, counted only for a change presence saw after the drive
 *   started (the #7234 sequence rule).
 * - Says a lost path once (a warning buzz, one screen-reader line, the caption
 *   beside the board art), per drive or per press, never per pick, and never
 *   after the climber stopped driving: a stop supersedes the relay in flight.
 *
 * The engaged path (`relay-path-store.ts`) is what Always drive the wall
 * starts on (`DriveModeWatcher`); a change of holder disengages it.
 */
export function useRelayedDrive(drive: DriveModeState | null): void {
  const { t } = useTranslation('session');
  const presence = useContext(BoardPresenceCurrentContext);
  const holder = presence?.holder ?? null;
  const holderChangeSeq = presence?.lastHolderChangeSeq ?? 0;
  const { boardId, relayClimbForBoard } = useBoardPresenceControls();
  const relayHolder = useRelayHolder();
  const bluetooth = useOptionalBluetoothContext();
  const localConnected = bluetooth?.isConnected ?? false;
  const activeClimbUuid = useActiveClimbUuid();
  const { getQueueSnapshot } = useQueueActions();
  const engaged = useEngagedRelayPath();

  const latestRef = useRef({ boardId, relayHolder, holder, holderChangeSeq, t, relayClimbForBoard, getQueueSnapshot });
  latestRef.current = { boardId, relayHolder, holder, holderChangeSeq, t, relayClimbForBoard, getQueueSnapshot };

  const sender = useMemo(
    () =>
      createRelaySender({
        relayClimb: (args) => latestRef.current.relayClimbForBoard(args),
        subscribeEchoes: subscribeRelayEchoes,
        mintId: mintRelayRequestId,
      }),
    [],
  );

  const sayLost = useCallback((kind: RelayLostNotice['kind'], name: string | null, episode: string) => {
    if (!claimRelayLostPath(episode)) return;
    const notice: RelayLostNotice = { kind, name };
    showRelayLost(notice);
    hapticWarning();
    announceQueued(spokenCaption(formatRelayLost(notice, latestRef.current.t)));
  }, []);

  // The drive (by its start) and the last climb counted for it.
  const countedRef = useRef<{ startedAt: number; climbUuid: string } | null>(null);
  // The last relay sent: who to, for a lost path said outside a drive.
  const lastSendRef = useRef<RelaySendContext | null>(null);
  const handledRef = useRef(new WeakSet<Promise<RelayOutcome>>());

  const handleOutcome = useCallback(
    (outcome: RelayOutcome, context: RelaySendContext) => {
      const current = getDriveMode();
      const effect = relayOutcomeEffect(outcome, current);
      if (effect.engage) {
        engageRelayPath({ boardId: context.boardId, holderKey: context.holderKey });
        clearRelayLost();
      }
      if (effect.goLive) {
        markDriveLive({ boardId: context.boardId });
        hapticSuccess();
      }
      if (outcome.kind === 'confirmed') {
        const live = getDriveMode();
        if (live?.relayed && live.phase === 'live') {
          const last = countedRef.current;
          if (!(last && last.startedAt === live.startedAt && last.climbUuid === outcome.climbUuid)) {
            countedRef.current = { startedAt: live.startedAt, climbUuid: outcome.climbUuid };
            noteDriveClimbLit();
          }
        }
      }
      if (effect.suppress) {
        suppressRelayPath({ boardId: context.boardId, holderChangeSeq: latestRef.current.holderChangeSeq });
      }
      if (effect.disengage) disengageRelayPath();
      if (effect.endDrive) exitDriveMode(effect.endDrive);
      if (effect.notice) {
        sayLost(effect.notice, context.holderName, current?.relayed ? `drive:${current.startedAt}` : context.episode);
      }
    },
    [sayLost],
  );

  const relay = useCallback(
    (requested: ClimbQueueItem | null): boolean => {
      const { boardId: currentBoardId, relayHolder: currentHolder } = latestRef.current;
      const item = requested ?? latestRef.current.getQueueSnapshot().currentClimbQueueItem;
      if (!item) return false;
      const holderKey = relayHolderKeyOf(currentHolder);
      if (currentBoardId === null || holderKey === null) return false;
      const driveAtSend = getDriveMode();
      const context: RelaySendContext = {
        boardId: currentBoardId,
        holderKey,
        holderName: relayHolderNameOf(currentHolder),
        episode: driveAtSend?.relayed ? `drive:${driveAtSend.startedAt}` : `press:${Date.now()}:${item.uuid}`,
      };
      lastSendRef.current = context;
      const outcome = sender.send({
        boardId: currentBoardId,
        climb: queueItemToRelayInput(item),
        angle: item.climb.angle ?? null,
        mirrored: item.climb.mirrored === true,
      });
      // A press and the drive it starts can ask for the same climb: one outcome, handled once.
      if (handledRef.current.has(outcome)) return true;
      handledRef.current.add(outcome);
      void outcome.then((result) => handleOutcome(result, context));
      return true;
    },
    [sender, handleOutcome],
  );

  useEffect(() => registerRelayRunner(relay), [relay]);

  // A relayed drive that ended says nothing about a relay still on its way.
  useEffect(
    () =>
      subscribeDriveEnded((ended) => {
        if (driveEndSupersedesRelay(ended)) sender.cancel();
      }),
    [sender],
  );

  // Follow a relayed drive: its first climb (unless it started live) and every change after.
  // Keyed on the climb with its angle and orientation. The server lights a
  // MoonBoard climb unmirrored whatever is asked, so a flip alone has nothing
  // to relay and nothing here listens for one.
  const followRef = useRef<{ startedAt: number; climbKey: string | null } | null>(null);
  const relayedStartedAt = drive?.relayed ? drive.startedAt : null;
  useEffect(() => {
    const current = getDriveMode();
    if (!current?.relayed) {
      followRef.current = null;
      return;
    }
    const item = latestRef.current.getQueueSnapshot().currentClimbQueueItem;
    const climbKey = item
      ? `${item.climb.uuid}:${item.climb.angle ?? ''}:${item.climb.mirrored === true ? 1 : 0}`
      : null;
    const seen = followRef.current;
    if (!seen || seen.startedAt !== current.startedAt) {
      followRef.current = { startedAt: current.startedAt, climbKey };
      // Always drive the wall's drive starts live and lights nothing of its own.
      if (current.phase === 'live') return;
    } else {
      if (seen.climbKey === climbKey) return;
      followRef.current = { startedAt: current.startedAt, climbKey };
    }
    if (item) relay(item);
  }, [relayedStartedAt, activeClimbUuid, relay]);

  // Watch the holder a relayed drive started on.
  const driveHolderRef = useRef<{
    startedAt: number;
    holderKey: string | null;
    seq: number;
    name: string | null;
  } | null>(null);
  useEffect(() => {
    const current = getDriveMode();
    if (current?.relayed) {
      let start = driveHolderRef.current;
      if (start?.startedAt !== current.startedAt) {
        const startHolder = latestRef.current.relayHolder ?? holder;
        start = {
          startedAt: current.startedAt,
          holderKey: relayHolderKeyOf(startHolder),
          seq: holderChangeSeq,
          name: relayHolderNameOf(startHolder),
        };
        driveHolderRef.current = start;
        return;
      }
      if (start.holderKey === null) return;
      const exit = resolveRelayedDriveHolderExit({
        startHolderKey: start.holderKey,
        startSeq: start.seq,
        holder,
        holderChangeSeq,
      });
      if (!exit) return;
      sender.cancel();
      disengageRelayPath();
      exitDriveMode(exit);
      sayLost('holder_left', start.name, `drive:${start.startedAt}`);
      return;
    }
    driveHolderRef.current = null;
    // No drive: a single relay still on its way to a holder who just went.
    const lastSend = lastSendRef.current;
    if (!lastSend) return;
    if (relayHolderKeyOf(holder) === lastSend.holderKey) return;
    if (sender.isPending()) {
      sender.cancel();
      sayLost('holder_left', lastSend.holderName, lastSend.episode);
    }
    disengageRelayPath();
  }, [drive, holder, holderChangeSeq, sender, sayLost]);

  // No one to relay through any more (the holder went idle or joined this
  // phone's crew, this phone linked, the flag went off): the path goes with
  // them, and a relayed drive ends rather than run on lighting nothing. Said
  // only by the holder watch above, which knows the holder actually left.
  const relayHolderGone = relayHolder === null;
  useEffect(() => {
    if (!relayHolderGone) return;
    disengageRelayPath();
    if (getDriveMode()?.relayed) {
      sender.cancel();
      exitDriveMode('holder_left');
    }
  }, [relayHolderGone, drive, sender]);

  // A path that went frees a stop made on it, as a dropped link does.
  const wasEngagedRef = useRef(engaged !== null);
  useEffect(() => {
    const isEngaged = engaged !== null;
    if (wasEngagedRef.current && !isEngaged) clearDrivingStopped();
    wasEngagedRef.current = isEngaged;
  }, [engaged]);

  // The caption is about a path that is gone: this phone's own link, a new
  // drive or another board takes it down.
  const driving = drive !== null;
  useEffect(() => {
    if (localConnected || driving) clearRelayLost();
  }, [localConnected, driving]);
  const boardIdRef = useRef(boardId);
  useEffect(() => {
    if (boardIdRef.current === boardId) return;
    boardIdRef.current = boardId;
    sender.cancel();
    disengageRelayPath();
    clearRelayLost();
    // A relayed drive still arming on the old board would otherwise wait out
    // the 30 s arming clock (`board_changed` only ends live drives there).
    if (getDriveMode()?.relayed) exitDriveMode('board_changed');
  }, [boardId, sender]);
}

/**
 * Relay mode (#7220): the relaying phone's engine (`useRelayedDrive`). Renders
 * nothing. Mounted once in the root layout beside `DriveModeWatcher`.
 */
export function BoardRelayWatcher(): null {
  useRelayedDrive(useDriveMode());
  return null;
}
