/**
 * `setQueue` merge-on-write (issue #3933, residual of #3906).
 *
 * #3906 made sequence allocation atomic but left `setQueue` writing with
 * `CAS_ANY_VERSION` on purpose — its payload is entirely client-supplied, so
 * there was nothing to recompute. The residual: a party member's
 * `addQueueItem` landing between the moment a client composed a wholesale
 * replace and the moment the server wrote it was silently discarded, with no
 * drift the client hash watchdog could ever see (the server's post-write state
 * is internally consistent, exactly as in the original bug).
 *
 * `setQueue` now accepts the caller's `baselineSequence` — the last sequence it
 * had APPLIED — replays the queue-event buffer over that window, and re-appends
 * peer adds the caller never saw.
 *
 * The tests are deliberately not timing-dependent: an in-memory stand-in for
 * the Redis replay buffer (fed from the real `publishQueueEvent` calls) lets
 * the interesting interleavings be pinned exactly, including the ones a real
 * buffer only reaches by luck (a write still in flight, an evicted window).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test';
import { v4 as uuidv4 } from 'uuid';
import type { ClimbQueueItem, QueueEvent, QueueState } from '@boardsesh/shared-schema';
import { roomManager, VersionConflictError } from '../services/room-manager';
import { queueMutations } from '../graphql/resolvers/queue/mutations';
import { collectConcurrentAdds } from '../graphql/resolvers/queue/set-queue-merge';
import { pubsub } from '../pubsub';
import { createMockRedis, type MockRedis } from './helpers/mock-redis';

const createTestClimb = (name = 'Test Climb'): ClimbQueueItem => ({
  uuid: uuidv4(),
  climb: {
    uuid: uuidv4(),
    setter_username: 'TestSetter',
    name,
    description: 'A test climb',
    frames: '{}',
    angle: 40,
    ascensionist_count: 10,
    difficulty: '6A',
    quality_average: '3.5',
    stars: 3.5,
    difficulty_error: '0.5',
    mirrored: false,
    benchmark_difficulty: null,
  },
  addedBy: 'test-user',
  tickedBy: [],
  suggested: false,
});

const mockCtx = (connectionId: string, sessionId: string) => ({
  connectionId,
  sessionId,
  rateLimitTokens: 1000,
  rateLimitLastReset: Date.now(),
});

const registerAndJoinSession = async (clientId: string, sessionId: string, boardPath: string, username: string) => {
  await roomManager.registerClient(clientId);
  return roomManager.joinSession(clientId, sessionId, boardPath, username);
};

/**
 * Stand-in for the Redis replay buffer, fed from the events the resolvers
 * actually publish. Mirrors the real thing's contract — `PlaybackStateChanged`
 * is never stored, reads come back ascending — while letting a test hold an
 * event back (buffer write still in flight) or drop the oldest ones (eviction)
 * without racing anything.
 */
function installFakeEventBuffer() {
  const stored: QueueEvent[] = [];
  /** Events written but deliberately not yet visible to a reader. */
  let withheldFromTail = 0;
  /** Sequences below this are treated as evicted/expired out of the buffer. */
  let evictBelowSequence = Number.NEGATIVE_INFINITY;

  vi.spyOn(pubsub, 'isRedisConnected').mockReturnValue(true);
  vi.spyOn(pubsub, 'publishQueueEvent').mockImplementation((_sessionId: string, event: QueueEvent) => {
    if (event.__typename !== 'PlaybackStateChanged') stored.push(event);
  });
  vi.spyOn(pubsub, 'getEventsSince').mockImplementation(async (_sessionId: string, sinceSequence: number) => {
    const visible = withheldFromTail > 0 ? stored.slice(0, -withheldFromTail) : stored;
    return visible
      .filter((event) => event.sequence > sinceSequence && event.sequence >= evictBelowSequence)
      .slice()
      .sort((left, right) => left.sequence - right.sequence);
  });

  return {
    published: stored,
    /** Everything published so far, as the buffer would return it. */
    lastFullSync: (): QueueState | undefined => {
      const fullSyncs = stored.filter((event) => event.__typename === 'FullSync');
      const latest = fullSyncs[fullSyncs.length - 1];
      return latest && latest.__typename === 'FullSync' ? latest.state : undefined;
    },
    /** Hide the newest `count` buffered events — the fire-and-forget LPUSH lag. */
    withholdNewest: (count: number) => {
      withheldFromTail = count;
    },
    /** Drop everything below `sequence` — eviction past 100 events / the TTL. */
    evictBelow: (sequence: number) => {
      evictBelowSequence = sequence;
    },
  };
}

describe('setQueue merges concurrent adds (#3933)', () => {
  let mockRedis: MockRedis;

  beforeEach(async () => {
    mockRedis = createMockRedis();
    roomManager.reset();
    await roomManager.initialize(mockRedis);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Session + a seeded queue, returning the sequence a client would have applied. */
  const seedSession = async (climbs: ClimbQueueItem[]) => {
    const sessionId = uuidv4();
    await registerAndJoinSession('client-1', sessionId, '/kilter/1/2/3/40', 'User1');
    const seeded = await queueMutations.setQueue(
      undefined,
      { queue: climbs, currentClimbQueueItem: undefined },
      mockCtx('client-1', sessionId) as never,
    );
    return { sessionId, baselineSequence: seeded.sequence };
  };

  it('re-appends a peer add that landed after the caller composed its payload', async () => {
    const buffer = installFakeEventBuffer();
    const existing = createTestClimb('already-queued');
    const { sessionId, baselineSequence } = await seedSession([existing]);

    // The peer's add commits after the caller read its baseline.
    const peerClimb = createTestClimb('added-by-peer');
    await queueMutations.addQueueItem(undefined, { item: peerClimb }, mockCtx('client-2', sessionId) as never);

    // The caller replaces the whole queue from its (now stale) view.
    const replacement = createTestClimb('activated-playlist-climb');
    const state = await queueMutations.setQueue(
      undefined,
      { queue: [replacement], currentClimbQueueItem: undefined, baselineSequence },
      mockCtx('client-1', sessionId) as never,
    );

    expect(state.queue.map((item) => item.uuid)).toEqual([replacement.uuid, peerClimb.uuid]);
    // The broadcast everyone converges on carries the survivor too — the old
    // behaviour published an internally consistent state with the add gone.
    expect(buffer.lastFullSync()?.queue.map((item) => item.uuid)).toEqual([replacement.uuid, peerClimb.uuid]);

    const committed = await roomManager.getQueueState(sessionId);
    expect(committed.queue.map((item) => item.uuid)).toEqual([replacement.uuid, peerClimb.uuid]);
    // `existing` was genuinely replaced away — the merge re-appends only what
    // arrived after the baseline, it does not resurrect the old queue.
    expect(committed.queue.some((item) => item.uuid === existing.uuid)).toBe(false);
  });

  it('does not resurrect a peer add that a peer then removed inside the same window', async () => {
    installFakeEventBuffer();
    const { sessionId, baselineSequence } = await seedSession([createTestClimb('already-queued')]);

    const transient = createTestClimb('added-then-removed');
    await queueMutations.addQueueItem(undefined, { item: transient }, mockCtx('client-2', sessionId) as never);
    await queueMutations.removeQueueItem(undefined, { uuid: transient.uuid }, mockCtx('client-2', sessionId) as never);

    const replacement = createTestClimb('replacement');
    const state = await queueMutations.setQueue(
      undefined,
      { queue: [replacement], currentClimbQueueItem: undefined, baselineSequence },
      mockCtx('client-1', sessionId) as never,
    );

    expect(state.queue.map((item) => item.uuid)).toEqual([replacement.uuid]);
  });

  it('does not duplicate a climb the caller already carries in its payload', async () => {
    installFakeEventBuffer();
    const { sessionId, baselineSequence } = await seedSession([createTestClimb('already-queued')]);

    const shared = createTestClimb('in-both');
    await queueMutations.addQueueItem(undefined, { item: shared }, mockCtx('client-2', sessionId) as never);

    const state = await queueMutations.setQueue(
      undefined,
      { queue: [shared], currentClimbQueueItem: undefined, baselineSequence },
      mockCtx('client-1', sessionId) as never,
    );

    expect(state.queue.map((item) => item.uuid)).toEqual([shared.uuid]);
  });

  it("does not resurrect the caller's own not-yet-echoed add", async () => {
    installFakeEventBuffer();
    const { sessionId, baselineSequence } = await seedSession([createTestClimb('already-queued')]);

    // The caller queues a climb, then replaces the whole queue before its own
    // subscription echo advances the sync gate — so its baseline predates its
    // own add. Re-appending it would fight the climber's replace.
    const ownClimb = createTestClimb('own-add');
    await queueMutations.addQueueItem(undefined, { item: ownClimb }, mockCtx('client-1', sessionId) as never);

    const replacement = createTestClimb('replacement');
    const state = await queueMutations.setQueue(
      undefined,
      { queue: [replacement], currentClimbQueueItem: undefined, baselineSequence },
      mockCtx('client-1', sessionId) as never,
    );

    expect(state.queue.map((item) => item.uuid)).toEqual([replacement.uuid]);
  });

  it('keeps the legacy wholesale overwrite when no baselineSequence is sent (old clients)', async () => {
    installFakeEventBuffer();
    const { sessionId } = await seedSession([createTestClimb('already-queued')]);

    const peerClimb = createTestClimb('added-by-peer');
    await queueMutations.addQueueItem(undefined, { item: peerClimb }, mockCtx('client-2', sessionId) as never);

    const replacement = createTestClimb('replacement');
    const state = await queueMutations.setQueue(
      undefined,
      { queue: [replacement], currentClimbQueueItem: undefined },
      mockCtx('client-1', sessionId) as never,
    );

    // Byte-for-byte the pre-#3933 contract: the peer's add is overwritten.
    expect(state.queue.map((item) => item.uuid)).toEqual([replacement.uuid]);
  });

  it('degrades to the legacy overwrite when the buffer write is still in flight', async () => {
    const buffer = installFakeEventBuffer();
    const { sessionId, baselineSequence } = await seedSession([createTestClimb('already-queued')]);

    const peerClimb = createTestClimb('added-by-peer');
    await queueMutations.addQueueItem(undefined, { item: peerClimb }, mockCtx('client-2', sessionId) as never);
    // The add is committed to queue state but its buffer LPUSH hasn't landed —
    // the real buffer write is fire-and-forget and runs strictly after the CAS.
    // Merging on this evidence would drop the add while claiming coverage.
    buffer.withholdNewest(1);

    const replacement = createTestClimb('replacement');
    const state = await queueMutations.setQueue(
      undefined,
      { queue: [replacement], currentClimbQueueItem: undefined, baselineSequence },
      mockCtx('client-1', sessionId) as never,
    );

    expect(state.queue.map((item) => item.uuid)).toEqual([replacement.uuid]);
  });

  it('degrades to the legacy overwrite when the buffer no longer reaches the baseline', async () => {
    const buffer = installFakeEventBuffer();
    const { sessionId, baselineSequence } = await seedSession([createTestClimb('already-queued')]);

    const peerClimb = createTestClimb('added-by-peer');
    await queueMutations.addQueueItem(undefined, { item: peerClimb }, mockCtx('client-2', sessionId) as never);
    const afterAdd = await roomManager.getQueueState(sessionId);
    // Everything up to and including the peer's add has aged out of the
    // 100-entry / 5-minute buffer, so the window can only be described partly.
    buffer.evictBelow(afterAdd.sequence + 1);

    const replacement = createTestClimb('replacement');
    const state = await queueMutations.setQueue(
      undefined,
      { queue: [replacement], currentClimbQueueItem: undefined, baselineSequence },
      mockCtx('client-1', sessionId) as never,
    );

    expect(state.queue.map((item) => item.uuid)).toEqual([replacement.uuid]);
  });

  it('degrades to the legacy overwrite when Redis (and so the buffer) is off', async () => {
    vi.spyOn(pubsub, 'isRedisConnected').mockReturnValue(false);
    const eventsSpy = vi.spyOn(pubsub, 'getEventsSince');
    const { sessionId, baselineSequence } = await seedSession([createTestClimb('already-queued')]);

    const replacement = createTestClimb('replacement');
    const state = await queueMutations.setQueue(
      undefined,
      { queue: [replacement], currentClimbQueueItem: undefined, baselineSequence },
      mockCtx('client-1', sessionId) as never,
    );

    expect(state.queue.map((item) => item.uuid)).toEqual([replacement.uuid]);
    expect(eventsSpy).not.toHaveBeenCalled();
  });

  it('falls back to the legacy overwrite instead of failing when the merge CAS keeps conflicting', async () => {
    installFakeEventBuffer();
    const { sessionId, baselineSequence } = await seedSession([createTestClimb('already-queued')]);

    // Every versioned write conflicts — a session under sustained concurrent
    // write pressure. A wholesale replace must not acquire a brand-new
    // user-facing failure mode it never had before #3933.
    const realUpdate = roomManager.updateQueueState.bind(roomManager);
    const updateSpy = vi
      .spyOn(roomManager, 'updateQueueState')
      .mockImplementation(async (id, queue, currentClimb, expectedVersion) => {
        if (expectedVersion !== undefined) throw new VersionConflictError(id, expectedVersion);
        return realUpdate(id, queue, currentClimb, expectedVersion);
      });

    const replacement = createTestClimb('replacement');
    const state = await queueMutations.setQueue(
      undefined,
      { queue: [replacement], currentClimbQueueItem: undefined, baselineSequence },
      mockCtx('client-1', sessionId) as never,
    );

    expect(state.queue.map((item) => item.uuid)).toEqual([replacement.uuid]);
    // The unversioned fallback write is the one that actually committed.
    expect(updateSpy.mock.calls.some((call) => call[3] === undefined)).toBe(true);
  });

  it('re-reads the buffer once before giving up, so a slow LPUSH still merges', async () => {
    const buffer = installFakeEventBuffer();
    const { sessionId, baselineSequence } = await seedSession([createTestClimb('already-queued')]);

    const peerClimb = createTestClimb('added-by-peer');
    await queueMutations.addQueueItem(undefined, { item: peerClimb }, mockCtx('client-2', sessionId) as never);
    buffer.withholdNewest(1);

    // The buffer write lands while the resolver is between its two reads.
    const eventsSpy = vi.spyOn(pubsub, 'getEventsSince');
    const originalImplementation = eventsSpy.getMockImplementation()!;
    let reads = 0;
    eventsSpy.mockImplementation(async (id: string, since: number) => {
      reads += 1;
      if (reads > 1) buffer.withholdNewest(0);
      return originalImplementation(id, since);
    });

    const replacement = createTestClimb('replacement');
    const state = await queueMutations.setQueue(
      undefined,
      { queue: [replacement], currentClimbQueueItem: undefined, baselineSequence },
      mockCtx('client-1', sessionId) as never,
    );

    expect(reads).toBeGreaterThan(1);
    expect(state.queue.map((item) => item.uuid)).toEqual([replacement.uuid, peerClimb.uuid]);
  });
});

describe('collectConcurrentAdds', () => {
  const peerAdd = (sequence: number, item: ClimbQueueItem, clientId: string | null): QueueEvent => ({
    __typename: 'QueueItemAdded',
    sequence,
    stateHash: `hash-${sequence}`,
    item,
    position: 0,
    clientId,
  });

  it('reports nothing to merge when the caller is level with committed state', async () => {
    const readEvents = vi.fn(async () => []);
    const outcome = await collectConcurrentAdds({
      sessionId: 'session-1',
      baselineSequence: 7,
      incomingUuids: new Set<string>(),
      currentState: { queue: [], sequence: 7 },
      callerClientId: 'client-1',
      readEvents,
    });

    expect(outcome).toEqual({ status: 'merged', survivors: [] });
    // No buffer round trip at all when there is provably no window.
    expect(readEvents).not.toHaveBeenCalled();
  });

  it('degrades rather than throwing when the buffer read fails', async () => {
    const climb = createTestClimb();
    const outcome = await collectConcurrentAdds({
      sessionId: 'session-1',
      baselineSequence: 1,
      incomingUuids: new Set<string>(),
      currentState: { queue: [climb], sequence: 2 },
      callerClientId: 'client-1',
      readEvents: async () => {
        throw new Error('Event buffer requires Redis');
      },
    });

    expect(outcome).toEqual({ status: 'degraded', reason: 'buffer-read-failed' });
  });

  it('never treats two anonymous connections as the same client', async () => {
    // `clientId` is coerced to null for connections without an id. Comparing
    // null to null would make one anonymous client's replace swallow another
    // anonymous client's add — the echo-suppression bug in merge clothing.
    const climb = createTestClimb('anonymous-peer-add');
    const outcome = await collectConcurrentAdds({
      sessionId: 'session-1',
      baselineSequence: 1,
      incomingUuids: new Set<string>(),
      currentState: { queue: [climb], sequence: 2 },
      callerClientId: null,
      readEvents: async () => [peerAdd(2, climb, null)],
    });

    expect(outcome).toEqual({ status: 'merged', survivors: [climb] });
  });

  it('ignores an add whose item no longer sits in committed state', async () => {
    const climb = createTestClimb('gone-by-another-path');
    const outcome = await collectConcurrentAdds({
      sessionId: 'session-1',
      baselineSequence: 1,
      incomingUuids: new Set<string>(),
      currentState: { queue: [], sequence: 2 },
      callerClientId: 'client-1',
      readEvents: async () => [peerAdd(2, climb, 'client-2')],
    });

    expect(outcome).toEqual({ status: 'merged', survivors: [] });
  });
});
