import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type {
  ClimbQueueItem,
  ConnectionContext,
  QueueEvent,
  QueueState,
  SessionEvent,
  SessionUser,
} from '@boardsesh/shared-schema';

const hooks = vi.hoisted(() => ({
  path: '/b/own/40',
  session: new Set<(event: SessionEvent) => void>(),
  queue: new Set<(event: QueueEvent) => void>(),
  releases: [] as ReturnType<typeof vi.fn>[],
  subscribeQueue: vi.fn(),
  getQueueState: vi.fn(),
}));

vi.mock('../pubsub', () => ({
  pubsub: {
    subscribeSession: async (_sessionId: string, callback: (event: SessionEvent) => void) => {
      hooks.session.add(callback);
      const release = vi.fn(() => hooks.session.delete(callback));
      hooks.releases.push(release);
      return release;
    },
    subscribeQueue: hooks.subscribeQueue,
  },
}));
vi.mock('../graphql/resolvers/shared/helpers', () => ({ requireSessionMember: async () => {} }));
vi.mock('../services/privacy', () => ({ canAccessResource: async () => true }));
vi.mock('../graphql/resolvers/sessions/live-session-stats', () => ({
  buildSessionStatsUpdatedEvent: async () => null,
}));
vi.mock('../services/room-manager', () => ({
  roomManager: {
    getQueueState: hooks.getQueueState,
    getSessionUsers: async () => [
      { id: 'climber', userId: 'climber', username: 'Named climber', isLeader: false, connectionState: 'CONNECTED' },
    ],
    getSessionById: async () => ({ boardPath: hooks.path }),
  },
}));
vi.mock('../services/board-session-privacy', () => ({
  projectSessionBoardPath: async (path: string) => path,
  sessionParticipantId: (_sessionId: string, userId: string) => `opaque-${userId}`,
  sessionEventParticipantId: (_sessionId: string, userId: string) => `opaque-${userId}`,
  redactSessionUsers: async (users: SessionUser[]) =>
    users.map((user) => ({
      ...user,
      id: `opaque-${user.id}`,
      userId: hooks.path === '/b/own/40' ? user.userId : null,
      username: hooks.path === '/b/own/40' ? user.username : '',
    })),
}));
vi.mock('../services/privacy-queue-events', () => ({
  redactQueueEvent: async (event: QueueEvent) => event,
  redactQueueState: async (state: QueueState) => {
    const project = (item: ClimbQueueItem): ClimbQueueItem =>
      hooks.path === '/b/own/40'
        ? item
        : {
            ...item,
            addedBy: undefined,
            addedByUser: undefined,
            tickedBy: [],
          };
    return {
      ...state,
      queue: state.queue.map(project),
      currentClimbQueueItem: state.currentClimbQueueItem ? project(state.currentClimbQueueItem) : null,
    };
  },
}));

const { sessionSubscriptions } = await import('../graphql/resolvers/sessions/subscriptions');
const { queueSubscriptions } = await import('../graphql/resolvers/queue/subscriptions');
const context = { connectionId: 'peer', userId: 'peer', isAuthenticated: true } as ConnectionContext;
const item: ClimbQueueItem = {
  uuid: 'queue-item',
  addedBy: 'climber',
  tickedBy: ['climber'],
  climb: {
    uuid: 'climb',
    name: 'Project',
    setter_username: 'Setter',
    frames: 'p1r12',
    angle: 40,
    ascensionist_count: 1,
    difficulty: '6c/V5',
    quality_average: '3',
    stars: 3,
    difficulty_error: '0',
    benchmark_difficulty: null,
  },
};
const state: QueueState = { sequence: 8, stateHash: 'hash', queue: [item], currentClimbQueueItem: item };
function moveWall() {
  hooks.path = '/b/foreign/40';
  for (const callback of hooks.session)
    callback({ __typename: 'SessionBoardPathChanged', boardPath: hooks.path, changedByParticipantId: null });
}
function payload<Payload>(result: IteratorResult<Payload>): Payload {
  if (result.done) throw new Error('Subscription ended before its event');
  return result.value;
}

beforeEach(() => {
  hooks.path = '/b/own/40';
  hooks.session.clear();
  hooks.queue.clear();
  hooks.releases.length = 0;
  hooks.subscribeQueue
    .mockReset()
    .mockImplementation(async (_sessionId: string, callback: (event: QueueEvent) => void) => {
      hooks.queue.add(callback);
      const release = vi.fn(() => hooks.queue.delete(callback));
      hooks.releases.push(release);
      return release;
    });
  hooks.getQueueState.mockReset().mockResolvedValue(state);
});

describe('targeted session wall identity refresh', () => {
  it('withdraws names through installed presence events before the path and authoritative roster', async () => {
    const stream = sessionSubscriptions.sessionUpdates.subscribe(undefined, { sessionId: 'party' }, context);
    try {
      const seed = payload(await stream.next()).sessionUpdates;
      expect(seed).toMatchObject({
        __typename: 'SessionRosterSnapshot',
        users: [{ userId: 'climber', username: 'Named climber' }],
      });
      moveWall();
      expect(payload(await stream.next()).sessionUpdates).toMatchObject({
        __typename: 'UserPresenceChanged',
        user: { id: 'opaque-climber', userId: null, username: '' },
      });
      expect(payload(await stream.next()).sessionUpdates).toMatchObject({
        __typename: 'SessionBoardPathChanged',
        boardPath: '/b/foreign/40',
      });
      expect(payload(await stream.next()).sessionUpdates).toMatchObject({
        __typename: 'SessionRosterSnapshot',
        boardPath: '/b/foreign/40',
        users: [{ id: 'opaque-climber', userId: null, username: '' }],
      });
    } finally {
      await stream.return();
    }
    expect(hooks.session.size).toBe(0);
    for (const release of hooks.releases) expect(release).toHaveBeenCalledOnce();
  });

  it('applies an angle change as a bare path event, with no roster or queue refresh', async () => {
    const sessionStream = sessionSubscriptions.sessionUpdates.subscribe(undefined, { sessionId: 'party' }, context);
    const queueStream = queueSubscriptions.queueUpdates.subscribe(undefined, { sessionId: 'party' }, context);
    try {
      payload(await sessionStream.next());
      payload(await queueStream.next());
      for (const callback of hooks.session)
        callback({
          __typename: 'SessionBoardPathChanged',
          boardPath: '/b/own/45',
          changedByParticipantId: 'mover',
          wallChanged: false,
        } as SessionEvent);
      // Server-only fields never reach the client.
      expect(payload(await sessionStream.next()).sessionUpdates).toEqual({
        __typename: 'SessionBoardPathChanged',
        boardPath: '/b/own/45',
        changedByParticipantId: 'mover',
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(hooks.getQueueState).toHaveBeenCalledOnce();
    } finally {
      await sessionStream.return();
      await queueStream.return();
    }
  });

  it('re-projects a wall that moved under an unchanged path without sending a path event', async () => {
    const stream = sessionSubscriptions.sessionUpdates.subscribe(undefined, { sessionId: 'party' }, context);
    try {
      payload(await stream.next());
      hooks.path = '/b/foreign/40';
      for (const callback of hooks.session)
        callback({
          __typename: 'SessionBoardPathChanged',
          boardPath: 'stale/path/from/the/publisher',
          changedByParticipantId: null,
          wallChanged: true,
          pathUnchanged: true,
        } as SessionEvent);
      expect(payload(await stream.next()).sessionUpdates).toMatchObject({
        __typename: 'UserPresenceChanged',
        user: { userId: null },
      });
      // The snapshot carries the stored path, never the published one.
      expect(payload(await stream.next()).sessionUpdates).toMatchObject({
        __typename: 'SessionRosterSnapshot',
        boardPath: '/b/foreign/40',
        users: [{ userId: null }],
      });
    } finally {
      await stream.return();
    }
  });

  it('reprojects queue and current attribution at the unchanged sequence', async () => {
    const stream = queueSubscriptions.queueUpdates.subscribe(undefined, { sessionId: 'party' }, context);
    try {
      expect(payload(await stream.next()).queueUpdates).toMatchObject({
        __typename: 'FullSync',
        sequence: 8,
        state: { queue: [{ addedBy: 'climber' }] },
      });
      moveWall();
      const refreshed = payload(await stream.next()).queueUpdates;
      expect(refreshed).toMatchObject({
        __typename: 'FullSync',
        sequence: 8,
        state: { queue: [{ tickedBy: [] }], currentClimbQueueItem: { tickedBy: [] } },
      });
      if (refreshed.__typename !== 'FullSync') throw new Error('Expected authoritative queue refresh');
      expect(refreshed.state.queue[0].addedBy).toBeUndefined();
      expect(refreshed.state.currentClimbQueueItem?.addedBy).toBeUndefined();
    } finally {
      await stream.return();
    }
    expect(hooks.session.size).toBe(0);
    expect(hooks.queue.size).toBe(0);
    for (const release of hooks.releases) expect(release).toHaveBeenCalledOnce();
  });

  it('releases the added session listener if queue setup fails', async () => {
    hooks.subscribeQueue.mockRejectedValueOnce(new Error('queue channel unavailable'));
    const stream = queueSubscriptions.queueUpdates.subscribe(undefined, { sessionId: 'party' }, context);
    await expect(stream.next()).rejects.toThrow('queue channel unavailable');
    expect(hooks.session.size).toBe(0);
    for (const release of hooks.releases) expect(release).toHaveBeenCalledOnce();
  });

  it('cancels all listeners while an initial queue read is pending and retires its late result', async () => {
    let finishSeed!: (queue: QueueState) => void;
    hooks.getQueueState.mockReturnValueOnce(
      new Promise<QueueState>((resolve) => {
        finishSeed = resolve;
      }),
    );
    const stream = queueSubscriptions.queueUpdates.subscribe(undefined, { sessionId: 'party' }, context);
    const waiting = stream.next();
    await vi.waitFor(() => expect(hooks.getQueueState).toHaveBeenCalledOnce());
    await stream.return();
    expect(await waiting).toEqual({ done: true, value: undefined });
    expect(hooks.session.size).toBe(0);
    expect(hooks.queue.size).toBe(0);
    finishSeed(state);
    expect(await stream.next()).toEqual({ done: true, value: undefined });
    for (const release of hooks.releases) expect(release).toHaveBeenCalledOnce();
  });
});
