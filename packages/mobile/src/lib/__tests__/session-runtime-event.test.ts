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
  it('adapts roster, wall-disconnect, serial, and path events', () => {
    expect(toMobileSessionRuntimeEvent({ __typename: 'UserJoined', user })).toEqual({ __typename: 'UserJoined', user });
    expect(
      toMobileSessionRuntimeEvent({
        __typename: 'WallDisconnected',
        disconnectedByParticipantId: 'participant-1',
      }),
    ).toEqual({
      __typename: 'WallDisconnected',
      disconnectedByParticipantId: 'participant-1',
    });
    // A WallDisconnected with no originator still maps (the signal is session-wide).
    expect(toMobileSessionRuntimeEvent({ __typename: 'WallDisconnected' })).toEqual({
      __typename: 'WallDisconnected',
      disconnectedByParticipantId: null,
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

  it('adapts a SessionRosterSnapshot into a full-roster replace event', () => {
    const second: SessionUser = { ...user, id: 'participant-2', username: 'Blake', isLeader: true };
    expect(
      toMobileSessionRuntimeEvent({
        __typename: 'SessionRosterSnapshot',
        users: [user, second],
        boardPath: '/kilter/1/10/1,2/40/list',
      }),
    ).toEqual({
      __typename: 'SessionRosterSnapshot',
      users: [user, second],
      boardPath: '/kilter/1/10/1,2/40/list',
    });
  });

  it('maps a SessionRosterSnapshot with no users/boardPath to empty defaults', () => {
    expect(toMobileSessionRuntimeEvent({ __typename: 'SessionRosterSnapshot' })).toEqual({
      __typename: 'SessionRosterSnapshot',
      users: [],
      boardPath: null,
    });
  });

  it('ignores stats and incomplete events', () => {
    expect(toMobileSessionRuntimeEvent({ __typename: 'SessionStatsUpdated', totalSends: 1 })).toBeNull();
    expect(toMobileSessionRuntimeEvent({ __typename: 'UserJoined' })).toBeNull();
    expect(toMobileSessionRuntimeEvent({ __typename: 'SessionBoardPathChanged' })).toBeNull();
  });

  it('drops an unknown __typename (old client receiving a newer union member)', () => {
    // Additive-safety contract: a stale bundle whose mapper predates a new
    // SessionEvent member falls through the `default: null` guard and keeps the
    // JOIN roster instead of crashing — the reason SessionRosterSnapshot could
    // ship without breaking un-OTA'd clients.
    expect(toMobileSessionRuntimeEvent({ __typename: 'SomeFutureSessionEvent' })).toBeNull();
  });
});
