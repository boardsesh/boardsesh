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

  describe('SessionRosterSnapshot (seed / reconcile REPLACE)', () => {
    it('replaces the whole roster and applies boardPath while preserving own clientId', () => {
      const prev = session({
        clientId: 'participant-1',
        users: [user({ id: 'participant-1' }), user({ id: 'ghost-participant' })],
        boardPath: '/kilter/1/10/1,2/40/list',
      });

      const next = applySessionRuntimeEvent(prev, {
        __typename: 'SessionRosterSnapshot',
        // ghost-participant left while we weren't watching; participant-3 joined.
        users: [user({ id: 'participant-1' }), user({ id: 'participant-3' })],
        boardPath: '/kilter/1/10/1,2/30/list',
      });

      expect(next?.users.map((entry) => entry.id)).toEqual(['participant-1', 'participant-3']);
      expect(next?.clientId).toBe('participant-1');
      expect(next?.boardPath).toBe('/kilter/1/10/1,2/30/list');
    });

    it('re-injects the known-self row when the snapshot omits it (raced our JOIN)', () => {
      const prev = session({
        clientId: 'participant-1',
        users: [user({ id: 'participant-1', username: 'me' })],
      });

      const next = applySessionRuntimeEvent(prev, {
        __typename: 'SessionRosterSnapshot',
        users: [user({ id: 'participant-2' })],
      });

      // We are never erased from our own crew list.
      expect(next?.users.map((entry) => entry.id).sort()).toEqual(['participant-1', 'participant-2']);
      expect(next?.users.find((entry) => entry.id === 'participant-1')?.username).toBe('me');
    });

    it('re-derives own leadership from the snapshot leader flags', () => {
      const prev = session({ clientId: 'participant-1', isLeader: false });

      const promoted = applySessionRuntimeEvent(prev, {
        __typename: 'SessionRosterSnapshot',
        users: [user({ id: 'participant-1', isLeader: true }), user({ id: 'participant-2', isLeader: false })],
      });
      expect(promoted?.isLeader).toBe(true);

      const demoted = applySessionRuntimeEvent(session({ clientId: 'participant-1', isLeader: true }), {
        __typename: 'SessionRosterSnapshot',
        users: [user({ id: 'participant-1', isLeader: false }), user({ id: 'participant-2', isLeader: true })],
      });
      expect(demoted?.isLeader).toBe(false);
    });

    it('keeps prior leadership when the snapshot omits our own row', () => {
      const prev = session({ clientId: 'participant-1', isLeader: true });
      const next = applySessionRuntimeEvent(prev, {
        __typename: 'SessionRosterSnapshot',
        users: [user({ id: 'participant-2', isLeader: true })],
      });
      // Self re-injected with its prior isLeader, top-level isLeader unchanged.
      expect(next?.isLeader).toBe(true);
    });

    it('keeps the prior boardPath when the snapshot carries none', () => {
      const prev = session({ boardPath: '/kilter/1/10/1,2/40/list' });
      const next = applySessionRuntimeEvent(prev, {
        __typename: 'SessionRosterSnapshot',
        users: prev.users,
      });
      expect(next?.boardPath).toBe('/kilter/1/10/1,2/40/list');
    });

    it('coerces snapshot users through the injected coerceUser callback', () => {
      const prev = session({ clientId: 'participant-1' });
      const next = applySessionRuntimeEvent(
        prev,
        {
          __typename: 'SessionRosterSnapshot',
          users: [user({ id: 'participant-1', custom: 'kept', avatarUrl: null })],
        },
        {
          coerceUser: (incoming): TestUser => ({ ...incoming, avatarUrl: incoming.avatarUrl ?? undefined }),
        },
      );
      expect(next?.users[0].avatarUrl).toBeUndefined();
      expect(next?.users[0].custom).toBe('kept');
    });
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
