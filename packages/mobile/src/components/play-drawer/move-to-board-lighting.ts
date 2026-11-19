import type { KeepLightingPlan } from '../../lib/keep-lighting';
import { startKeepLighting } from './drive-runner';
import { clearDrivingStopped, exitDriveMode, getDriveMode, getLastDriveEnded } from './drive-mode-store';

type MoveLightingPolicy = { plan: KeepLightingPlan | null; resumeAlways: boolean };
let readLightingPolicy: (() => MoveLightingPolicy) | null = null;

/** The root watcher owns current settings and crew membership, even with no player open. */
export function registerMoveLightingPolicy(reader: () => MoveLightingPolicy): () => void {
  readLightingPolicy = reader;
  return () => {
    if (readLightingPolicy === reader) readLightingPolicy = null;
  };
}

type MoveLightingInput = {
  boardUuid: string;
  boardId?: number | null;
  boardType: string;
  climbUuid: string;
  sessionId: string | null;
  credentialScope: number;
  plan: KeepLightingPlan | null;
  resumeAlways?: boolean;
  move: () => Promise<boolean>;
  /** Live app-owned reads, valid even after the player closes. */
  isCurrent: () => boolean;
  relight: () => void;
};

// A phone has one board link. Players in different panes share this request,
// so a delayed connect cannot take over a newer press. Identical double taps
// share the move: the board switch rejects a second simultaneous request.
let pending: { key: string; completion: Promise<void> } | null = null;

/**
 * Put on {board}: finish the move before arming its drive. Arming on the old
 * link would accept its confirms, then end on its deliberate disconnect.
 * Reassert after arming: the destination's first auto-send may already have
 * landed, or been held by the stale-current gate. Only a fresh local confirm
 * makes the drive live; a successful connection alone never does.
 */
export function moveToBoardAndLight(input: MoveLightingInput): Promise<void> {
  const key = JSON.stringify([input.credentialScope, input.sessionId, input.boardUuid, input.climbUuid]);
  if (pending?.key === key) return pending.completion;
  const originalDrive = getDriveMode();
  const originalEnd = getLastDriveEnded();
  const request = { key, completion: Promise.resolve() };
  pending = request;
  request.completion = input
    .move()
    .then((connected) => {
      if (!connected || pending !== request || !input.isCurrent()) return;
      const currentDrive = getDriveMode();
      const currentEnd = getLastDriveEnded();
      // Another drive or a deliberate stop while the picker was open owns
      // the newer intent. Only the old board's handoff may be retired here.
      const automaticDrive = currentDrive?.startedBy === 'always';
      if (currentDrive && currentDrive.startedAt !== originalDrive?.startedAt && !automaticDrive) return;
      if (
        currentEnd !== null &&
        currentEnd !== originalEnd &&
        ((currentEnd?.drive?.startedAt !== originalDrive?.startedAt && currentEnd?.drive?.startedBy !== 'always') ||
          (currentEnd.reason !== 'link_dropped' &&
            currentEnd.reason !== 'board_changed' &&
            (currentEnd.reason !== 'window_ended' || currentEnd.disconnectAfter !== null)))
      )
        return;
      // Always drive may already have started on the new connection. It
      // deliberately writes nothing, so keep it and fulfill this press's
      // relight (including through the stale-current hold).
      const destinationAlreadyDriving =
        automaticDrive &&
        currentDrive.startedAt !== originalDrive?.startedAt &&
        input.boardId != null &&
        currentDrive.boardId === input.boardId &&
        currentDrive.boardType === input.boardType;
      if (currentDrive && !destinationAlreadyDriving) exitDriveMode('board_changed');
      // The picker can stay open while settings or the crew changes. The
      // original tap authorizes a drive; the live root policy still decides
      // whether it may start. With no watcher, fulfill only the one-climb press.
      const policy = readLightingPolicy?.();
      if ((input.resumeAlways || input.plan) && policy?.resumeAlways) clearDrivingStopped();
      const plan = input.plan && !policy?.resumeAlways ? policy?.plan : null;
      if (plan) {
        startKeepLighting({
          plan,
          sessionId: input.sessionId,
          boardType: input.boardType,
          // This request just established this phone's own target link.
          wallHeldByOtherUser: false,
        });
      }
      input.relight();
    })
    // Connection failures already have their own UI. They start no drive and
    // must not leave an unhandled rejection behind the button's void handler.
    .catch(() => undefined)
    .finally(() => {
      if (pending === request) pending = null;
    });
  return request.completion;
}
