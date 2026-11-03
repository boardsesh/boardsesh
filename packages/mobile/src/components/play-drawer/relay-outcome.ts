import type { DriveEnded, DriveModeState } from './drive-mode-store';
import type { RelayOutcome } from '../../lib/board-relay/relay-sender';

/**
 * What one relay's outcome does, pure so it is table-tested:
 *
 * - `confirmed`: the path is engaged; a relayed drive that was arming goes
 *   live, and a climb it hasn't counted yet counts.
 * - `holder_gone`: no phone can light it (no holder, this connection's own
 *   stale hold, a holder whose socket went): the path is suppressed until
 *   presence's holder changes, so the next Put on board connects. A relayed
 *   drive ends `holder_left`, and "{name}'s phone let go" is said.
 * - `unconfirmed`: it didn't land (no echo in 8 s, relays turned off, the
 *   climb unavailable, a failed request): a relayed drive ends
 *   `relay_unconfirmed`, and "Didn't reach the board through {name}'s phone"
 *   is said. Nothing is retried; the climb on screen stays a preview.
 * - `superseded`: nothing.
 */
export type RelayOutcomeEffect = {
  engage: boolean;
  disengage: boolean;
  suppress: boolean;
  endDrive: 'holder_left' | 'relay_unconfirmed' | null;
  notice: 'holder_left' | 'unconfirmed' | null;
  goLive: boolean;
};

export function relayOutcomeEffect(outcome: RelayOutcome, drive: DriveModeState | null): RelayOutcomeEffect {
  const relayedDrive = drive?.relayed === true;
  const none: RelayOutcomeEffect = {
    engage: false,
    disengage: false,
    suppress: false,
    endDrive: null,
    notice: null,
    goLive: false,
  };
  switch (outcome.kind) {
    case 'superseded':
      return none;
    case 'confirmed':
      return { ...none, engage: true, goLive: relayedDrive && drive?.phase === 'arming' };
    case 'holder_gone':
      return {
        ...none,
        disengage: true,
        suppress: true,
        endDrive: relayedDrive ? 'holder_left' : null,
        notice: 'holder_left',
      };
    case 'unconfirmed':
      return {
        ...none,
        disengage: true,
        endDrive: relayedDrive ? 'relay_unconfirmed' : null,
        notice: 'unconfirmed',
      };
  }
}

/**
 * Any end of a relayed drive (a stop at the wall, the clock, a setting, a
 * change of session or account), or a stop with no drive left, supersedes the
 * relay in flight: the drive is over, so a late failure says nothing. An end
 * the relay caused itself has already settled it.
 */
export function driveEndSupersedesRelay(ended: Pick<DriveEnded, 'reason' | 'drive'>): boolean {
  if (ended.drive === null) return ended.reason === 'stopped';
  return ended.drive.relayed === true;
}
