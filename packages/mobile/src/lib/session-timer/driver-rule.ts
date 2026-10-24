// Which phone may move the wall when a session timer runs out (#5397, #5382).
// Pure. The rest timer's scheduler, its sheet and every later timer surface read
// this one rule through `hooks/use-session-timer-driver.ts`, so they can never
// disagree about who paces a crew.
//
// The rule: solo, your timer moves your queue. In a crew, `nextClimb` broadcasts
// to everyone, so only the climber holding the wall may move it; anyone else's
// timer counts for their own pacing and never touches the shared queue.
//
// The gym timer (Rogue) is a separate question with today's answer kept: it is
// driven over THIS phone's Bluetooth link, so only a phone holding that link
// talks to it. Never widened by a virtual hold, so a phone without the LED link
// never scans for or connects to the timer.

import type { BoardConnection } from '../../components/play-drawer/lightbulb-control';

/**
 *   solo       no crew: this phone paces its own queue
 *   holder     a crew, and this phone holds the wall
 *   passenger  a crew, and someone else holds the wall
 *   unheld     a crew, and nobody holds the wall
 */
export type WallDriverRole = 'solo' | 'holder' | 'passenger' | 'unheld';

export type SessionTimerDriver = {
  role: WallDriverRole;
  /** May this phone's timer call `nextClimb()`. */
  canAdvanceQueue: boolean;
  /** May this phone drive the Rogue gym timer. */
  canDriveGymTimer: boolean;
  /** Why the auto-advance controls are off, for the sheet to say out loud. */
  blockedReason: 'crewPassenger' | null;
  /** Who paces the wall instead of this phone. Set only for a passenger with a named holder. */
  pacerDisplayName: string | null;
};

export type SessionTimerDriverInput = {
  /** Someone else is in this session, past the arming dwell (`useIsCrewSession`). */
  isCrewSession: boolean;
  /** Wall ownership as the in-app surfaces see it, virtual holds included. */
  inAppBoardConnection: BoardConnection;
  /** This phone holds the board's Bluetooth link. */
  localBleConnected: boolean;
  /** The peer holding the wall, when there is one. */
  holderDisplayName: string | null;
};

function roleFor(isCrewSession: boolean, inAppBoardConnection: BoardConnection): WallDriverRole {
  if (!isCrewSession) return 'solo';
  if (inAppBoardConnection === 'connectedByMe') return 'holder';
  if (inAppBoardConnection === 'heldByPeer') return 'passenger';
  // Anything else in a crew, including a value this rule does not know, is an
  // unheld wall: the answer that never moves a crew's queue.
  return 'unheld';
}

export function deriveSessionTimerDriver({
  isCrewSession,
  inAppBoardConnection,
  localBleConnected,
  holderDisplayName,
}: SessionTimerDriverInput): SessionTimerDriver {
  const role = roleFor(isCrewSession, inAppBoardConnection);
  const canAdvanceQueue = role === 'solo' || role === 'holder';
  return {
    role,
    canAdvanceQueue,
    canDriveGymTimer: localBleConnected,
    // An unheld wall blocks for the same reason as a held one: until someone
    // takes it, moving the shared queue from here would move it for everyone.
    blockedReason: canAdvanceQueue ? null : 'crewPassenger',
    pacerDisplayName: role === 'passenger' ? holderDisplayName : null,
  };
}
