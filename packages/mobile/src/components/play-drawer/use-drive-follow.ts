import { useEffect, useReducer, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { subscribeToWallConfirm } from '@boardsesh/play-view';
import { useActiveClimbUuid, useQueueActions } from '../../providers/queue-provider';
import { announceQueued } from '../../lib/announce-queued';
import { hapticLight, hapticSuccess } from '../../lib/haptics';
import { subscribeCrewMoves, type CrewMove } from '../../lib/relay-receipt';
import { resolveCurrentClimbMoverName } from '../../lib/current-climb-mover';
import { getCredentialGeneration, subscribeToCredentialChanges } from '../../lib/privacy/privacy-cache';
import { clearCrewPutUp, formatCrewPutUp, resolveCrewPutUp, showCrewPutUp } from './crew-put-up-store';
import { getDriveMode, markDriveLive, noteDriveClimbLit, type DriveModePhase } from './drive-mode-store';

/**
 * A crewmate puts a climb up while this phone drives the wall (#7113). This
 * phone's auto-sender lights it like any current climb, the player follows
 * (it shows the current climb), and the drive goes on. This says so for 4 s
 * where "Only you see this" sits, a light buzz, and one screen-reader
 * announcement. Only the event's server-stamped mover can name the person.
 *
 * Only a crewmate's move counts (`subscribeCrewMoves`: never this phone's own
 * or its echo), heard while live, and said once the queue has made it current.
 * Any other change of current climb first drops it: a crewmate's move the
 * driver's own swipe overtook is never said later.
 *
 * It reads the current climb through `useActiveClimbUuid` (a change of climb)
 * and stable snapshot readers. A receipt also wakes it when another slot of
 * the same climb becomes current; roster and stats changes never wake it.
 */
export function useDriveCrewPutUp(drivePhase: DriveModePhase | null, driveStartedAt: number | null): void {
  const { t } = useTranslation('session');
  const activeClimbUuid = useActiveClimbUuid();
  const { getQueueSnapshot, getSessionRosterSnapshot } = useQueueActions();
  const [receiptRevision, noteReceipt] = useReducer((revision: number) => revision + 1, 0);
  const pendingRef = useRef<
    (CrewMove & { sessionId: string | null; driveStartedAt: number; credentialGeneration: number }) | null
  >(null);

  useEffect(
    () =>
      subscribeCrewMoves((move) => {
        const drive = getDriveMode();
        if (drive?.phase !== 'live') return;
        pendingRef.current = {
          ...move,
          sessionId: getSessionRosterSnapshot().sessionId,
          driveStartedAt: drive.startedAt,
          credentialGeneration: getCredentialGeneration(),
        };
        // The queue dispatch follows this listener in the same React batch.
        // The effect reads the provider's updated stateRef after that commit.
        noteReceipt();
      }),
    [getSessionRosterSnapshot],
  );

  useEffect(() => {
    // A drive can become live in the very batch that receives a crew move.
    // Keep that move when it already belongs to the new generation.
    const pending = pendingRef.current;
    if (
      drivePhase !== 'live' ||
      pending?.driveStartedAt !== driveStartedAt ||
      pending?.sessionId !== getDriveMode()?.sessionId
    )
      pendingRef.current = null;
    clearCrewPutUp();
  }, [drivePhase, driveStartedAt]);

  useEffect(
    () =>
      subscribeToCredentialChanges(() => {
        pendingRef.current = null;
        clearCrewPutUp();
      }),
    [],
  );

  useEffect(
    () => () => {
      pendingRef.current = null;
      clearCrewPutUp();
    },
    [],
  );

  useEffect(() => {
    const pending = pendingRef.current;
    if (pending === null) return;
    // Settled either way: it landed, or another change of climb overtook it.
    pendingRef.current = null;
    const queue = getQueueSnapshot();
    const roster = getSessionRosterSnapshot();
    const current = queue.currentClimbQueueItem;
    const drive = getDriveMode();
    if (
      current?.uuid !== pending.queueItemUuid ||
      drive?.phase !== 'live' ||
      drive.startedAt !== pending.driveStartedAt ||
      drive.sessionId !== pending.sessionId ||
      roster.sessionId !== pending.sessionId ||
      queue.sessionId !== pending.sessionId ||
      pending.credentialGeneration !== getCredentialGeneration()
    )
      return;
    const notice = resolveCrewPutUp(
      current,
      resolveCurrentClimbMoverName({ ...roster, currentChangedBy: pending.currentChangedBy }),
    );
    if (!notice) return;
    showCrewPutUp(notice);
    hapticLight();
    announceQueued(formatCrewPutUp(notice, t));
  }, [activeClimbUuid, getQueueSnapshot, getSessionRosterSnapshot, receiptRevision, t]);
}

/**
 * Drive the arming → live step and count the climbs a drive lights, from the
 * wall-confirm bus (`@boardsesh/play-view`): this phone's auto-sender confirms
 * each climb its link actually lit (`handleWallConfirmed` in the Bluetooth
 * provider), and the crew feed replays the same confirm, never a new climb.
 *
 * - Arming goes live, with a success buzz, at the first confirm while this
 *   phone holds the link: the swipe's climb is lit. Here at the app root, so
 *   closing the player mid-connect still goes live.
 * - Each confirm of a climb other than the last one counted is one more climb
 *   lit (a re-send or an echo of the same climb is not), the swipe's own first.
 */
export function useDriveWallConfirms(linked: boolean): void {
  const linkedRef = useRef(linked);
  linkedRef.current = linked;
  // The drive (by its start) and the last climb counted for it.
  const lastCountedRef = useRef<{ startedAt: number; climbUuid: string } | null>(null);

  useEffect(
    () =>
      subscribeToWallConfirm((climbUuid) => {
        const drive = getDriveMode();
        if (!drive || !linkedRef.current) return;
        if (drive.phase === 'arming') {
          markDriveLive();
          hapticSuccess();
        }
        const last = lastCountedRef.current;
        if (last && last.startedAt === drive.startedAt && last.climbUuid === climbUuid) return;
        lastCountedRef.current = { startedAt: drive.startedAt, climbUuid };
        noteDriveClimbLit();
      }),
    [],
  );
}
