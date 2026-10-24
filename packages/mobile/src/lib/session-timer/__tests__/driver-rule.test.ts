// Who may move the wall. Every "may" here is paired with a "may not": the
// failure this rule exists to stop is one phone silently changing four other
// people's climb.
import { describe, expect, it } from 'vitest';
import type { BoardConnection } from '../../../components/play-drawer/lightbulb-control';
import { deriveSessionTimerDriver, type SessionTimerDriverInput } from '../driver-rule';

function driverFor(overrides: Partial<SessionTimerDriverInput>) {
  return deriveSessionTimerDriver({
    isCrewSession: false,
    inAppBoardConnection: 'disconnected',
    localBleConnected: false,
    holderDisplayName: null,
    ...overrides,
  });
}

describe('solo', () => {
  it.each<BoardConnection>(['connectedByMe', 'heldByPeer', 'disconnected'])(
    'moves its own queue whatever the board link says (%s)',
    (inAppBoardConnection) => {
      expect(driverFor({ inAppBoardConnection })).toMatchObject({
        role: 'solo',
        canAdvanceQueue: true,
        blockedReason: null,
        pacerDisplayName: null,
      });
    },
  );
});

describe('in a crew', () => {
  it('lets the climber holding the wall move it', () => {
    expect(driverFor({ isCrewSession: true, inAppBoardConnection: 'connectedByMe' })).toMatchObject({
      role: 'holder',
      canAdvanceQueue: true,
      blockedReason: null,
      pacerDisplayName: null,
    });
  });

  it('never lets a passenger move it, and names who paces instead', () => {
    expect(driverFor({ isCrewSession: true, inAppBoardConnection: 'heldByPeer', holderDisplayName: 'Sam' })).toEqual({
      role: 'passenger',
      canAdvanceQueue: false,
      canDriveGymTimer: false,
      blockedReason: 'crewPassenger',
      pacerDisplayName: 'Sam',
    });
  });

  it('never lets anyone move it while nobody holds it', () => {
    expect(driverFor({ isCrewSession: true, inAppBoardConnection: 'disconnected' })).toMatchObject({
      role: 'unheld',
      canAdvanceQueue: false,
      blockedReason: 'crewPassenger',
      pacerDisplayName: null,
    });
  });

  it('reads an unknown board state as unheld, the answer that never moves a crew', () => {
    const unknownConnection = 'connectedByPeer' as unknown as BoardConnection;
    expect(driverFor({ isCrewSession: true, inAppBoardConnection: unknownConnection })).toMatchObject({
      role: 'unheld',
      canAdvanceQueue: false,
    });
  });
});

describe('the gym timer', () => {
  it('follows this phone’s Bluetooth link alone, as it always has', () => {
    expect(driverFor({ localBleConnected: true }).canDriveGymTimer).toBe(true);
    expect(driverFor({ localBleConnected: false }).canDriveGymTimer).toBe(false);
  });

  it('is not widened by a virtual hold on a wall with no lights', () => {
    // A ledless wall held in the app reads as connectedByMe with no BLE link.
    expect(
      driverFor({ isCrewSession: true, inAppBoardConnection: 'connectedByMe', localBleConnected: false })
        .canDriveGymTimer,
    ).toBe(false);
  });

  it('stays with a passenger holding the board link, because the link is theirs', () => {
    expect(
      driverFor({ isCrewSession: true, inAppBoardConnection: 'heldByPeer', localBleConnected: true }).canDriveGymTimer,
    ).toBe(true);
  });
});
