import { describe, expect, it } from 'vitest';
import { applySessionRuntimeEvent, upsertRuntimeSessionUser, type RuntimeSessionState } from '../session-events';

type TestUser = {
  id: string;
  username: string;
  isLeader: boolean;
  avatarUrl?: string | null;
  userId?: string | null;
  connectionState?: string | null;
  custom?: string;
};

type TestSession = RuntimeSessionState<TestUser> & {
  id: string;
};

const user = (overrides: Partial<TestUser> = {}): TestUser => ({
  id: 'participant-1',
  username: 'tester',
  isLeader: false,
  avatarUrl: null,
  userId: null,
  connectionState: 'CONNECTED',
  ...overrides,
});

const session = (overrides: Partial<TestSession> = {}): TestSession => ({
  id: 'session-1',
  users: [user({ id: 'participant-1' })],
  isLeader: false,
  clientId: 'participant-1',
  lastConnectedBoardSerial: null,
  boardPath: '/kilter/1/10/1,2/40/list',
  ...overrides,
});

describe('upsertRuntimeSessionUser', () => {
  it('adds new users and replaces existing users by participant id', () => {
    const first = user({ id: 'participant-1', username: 'old' });
    const updated = user({ id: 'participant-1', username: 'new', userId: 'db-user' });

    expect(upsertRuntimeSessionUser([], first)).toEqual([first]);
    expect(upsertRuntimeSessionUser([first], updated)).toEqual([updated]);
  });
});

describe('applySessionRuntimeEvent', () => {
  it('upserts joined and presence users through the injected coerceUser callback', () => {
    const prev = session();
    const next = applySessionRuntimeEvent(
      prev,
      {
        __typename: 'UserPresenceChanged',
        user: user({ id: 'participant-2', avatarUrl: null, custom: 'kept' }),
      },
      {
        coerceUser: (incoming) => {
          const coercedUser: TestUser = {
            ...incoming,
            avatarUrl: incoming.avatarUrl ?? undefined,
          };
          return coercedUser;
        },
      },
    );

    expect(next?.users.map((entry) => entry.id)).toEqual(['participant-1', 'participant-2']);
    expect(next?.users[1].avatarUrl).toBeUndefined();
    expect(next?.users[1].custom).toBe('kept');
  });

  it('removes users by participant id', () => {
    const prev = session({ users: [user({ id: 'participant-1' }), user({ id: 'participant-2' })] });
    const next = applySessionRuntimeEvent(prev, { __typename: 'UserLeft', userId: 'participant-1' });

    expect(next?.users.map((entry) => entry.id)).toEqual(['participant-2']);
  });

  it('updates leader state', () => {
    const prev = session({
      users: [user({ id: 'participant-1', userId: null }), user({ id: 'participant-2', userId: 'db-user' })],
    });

    const next = applySessionRuntimeEvent(prev, {
      __typename: 'LeaderChanged',
      leaderId: 'participant-2',
      leaderConnectionId: null,
    });

    expect(next?.isLeader).toBe(false);
    expect(next?.users.find((entry) => entry.id === 'participant-2')?.isLeader).toBe(true);
  });

  it('tracks board serial and board path updates', () => {
    const withSerial = applySessionRuntimeEvent(session(), {
      __typename: 'SessionBoardSerialChanged',
      lastConnectedBoardSerial: 'AURORA-1',
    });
    expect(withSerial?.lastConnectedBoardSerial).toBe('AURORA-1');

    const withPath = applySessionRuntimeEvent(withSerial, {
      __typename: 'SessionBoardPathChanged',
      boardPath: '/kilter/1/10/1,2/30/list',
      changedByParticipantId: 'participant-2',
    });
    expect(withPath?.boardPath).toBe('/kilter/1/10/1,2/30/list');
  });

  it('leaves session state unchanged on wall disconnect (lightbulb is a UI concern)', () => {
    const prev = session({ lastConnectedBoardSerial: 'AURORA-1' });
    expect(
      applySessionRuntimeEvent(prev, {
        __typename: 'WallDisconnected',
        disconnectedByParticipantId: 'participant-1',
      }),
    ).toBe(prev);
  });

  it('leaves session-ended and null previous state unchanged', () => {
    const prev = session();

    expect(applySessionRuntimeEvent(prev, { __typename: 'SessionEnded', reason: 'manual', newPath: null })).toBe(prev);
    expect(
      applySessionRuntimeEvent(null, {
        __typename: 'WallDisconnected',
        disconnectedByParticipantId: 'participant-1',
      }),
    ).toBeNull();
  });
});
