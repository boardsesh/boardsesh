import { describe, expect, it } from 'vitest';
import type { SessionUser } from '@boardsesh/shared-schema';
import { toMobileSessionRuntimeEvent } from '../session-runtime-event';

const user: SessionUser = {
  id: 'participant-1',
  username: 'Alex',
  isLeader: false,
  avatarUrl: undefined,
  userId: 'db-user-1',
  connectionState: 'CONNECTED',
};

describe('toMobileSessionRuntimeEvent', () => {
  it('adapts roster, driver, serial, and path events', () => {
    expect(toMobileSessionRuntimeEvent({ __typename: 'UserJoined', user })).toEqual({ __typename: 'UserJoined', user });
    expect(toMobileSessionRuntimeEvent({ __typename: 'DriverChanged', driverParticipantId: 'participant-1' })).toEqual({
      __typename: 'DriverChanged',
      driverParticipantId: 'participant-1',
      previousDriverParticipantId: null,
    });
    expect(
      toMobileSessionRuntimeEvent({
        __typename: 'SessionBoardSerialChanged',
        lastConnectedBoardSerial: 'AURORA-1',
      }),
    ).toEqual({
      __typename: 'SessionBoardSerialChanged',
      lastConnectedBoardSerial: 'AURORA-1',
    });
    expect(
      toMobileSessionRuntimeEvent({
        __typename: 'SessionBoardPathChanged',
        boardPath: '/kilter/1/10/1,2/30/list',
        changedByParticipantId: 'participant-2',
      }),
    ).toEqual({
      __typename: 'SessionBoardPathChanged',
      boardPath: '/kilter/1/10/1,2/30/list',
      changedByParticipantId: 'participant-2',
    });
  });

  it('adapts WallConnectionChanged so the holder reaches wallConnectionsByBoard', () => {
    expect(
      toMobileSessionRuntimeEvent({ __typename: 'WallConnectionChanged', boardId: 42, holderParticipantId: 'p-1' }),
    ).toEqual({ __typename: 'WallConnectionChanged', boardId: 42, holderParticipantId: 'p-1' });
    // A freed slot (nobody holds it) maps the holder to null.
    expect(toMobileSessionRuntimeEvent({ __typename: 'WallConnectionChanged', boardId: 42 })).toEqual({
      __typename: 'WallConnectionChanged',
      boardId: 42,
      holderParticipantId: null,
    });
  });

  it('ignores stats and incomplete events', () => {
    expect(toMobileSessionRuntimeEvent({ __typename: 'SessionStatsUpdated', totalSends: 1 })).toBeNull();
    expect(toMobileSessionRuntimeEvent({ __typename: 'UserJoined' })).toBeNull();
    expect(toMobileSessionRuntimeEvent({ __typename: 'SessionBoardPathChanged' })).toBeNull();
    // No boardId → can't key wallConnectionsByBoard, so it's dropped.
    expect(toMobileSessionRuntimeEvent({ __typename: 'WallConnectionChanged' })).toBeNull();
  });
});
