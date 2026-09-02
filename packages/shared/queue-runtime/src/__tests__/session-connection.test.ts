import { describe, it, expect, vi } from 'vitest';
import { createSessionConnectionController } from '../session-connection';
import type {
  SessionConnectionDeps,
  SessionConnectionGate,
  SessionConnectionReplayResult,
  SessionConnectionSink,
} from '../session-connection';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

type TestSessionData = {
  // Nullable to mirror `SessionConnectionSessionData` (web's
  // `Session.queueState` is schema-nullable); the rejoin path treats a null
  // snapshot as a failed rejoin — see the dedicated test below.
  queueState: { sequence: number; stateHash: string } | null;
  label: string;
};

type TestQueueEvent = { __typename: string; sequence: number; stateHash?: string };
type TestSessionEvent = { kind: string };

type TestClient = { id: number; disposed: boolean; dispose: () => void };

function createTestClient(id: number): TestClient {
  const client: TestClient = {
    id,
    disposed: false,
    dispose: () => {
      client.disposed = true;
    },
  };
  return client;
}

/** Deterministic stand-in for `setTimeout`/`clearTimeout` — tests flush
 *  timers explicitly instead of racing vitest's fake timers against
 *  in-flight promises. */
function createTimerHarness() {
  let nextId = 1;
  const pending = new Map<number, { callback: () => void; delayMs: number }>();
  return {
    scheduleTimer: (callback: () => void, delayMs: number): number => {
      const id = nextId++;
      pending.set(id, { callback, delayMs });
      return id;
    },
    clearTimer: (handle: unknown): void => {
      pending.delete(handle as number);
    },
    /** Fire every pending timer's callback (in scheduling order), clearing
     *  the queue first so a callback that reschedules doesn't get flushed
     *  again in the same pass. */
    flushAll(): void {
      const timers = [...pending.values()];
      pending.clear();
      timers.forEach((timer) => timer.callback());
    },
    get pendingCount(): number {
      return pending.size;
    },
    get pendingDelays(): number[] {
      return [...pending.values()].map((timer) => timer.delayMs);
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createGate(initialLastSequence: number | null): SessionConnectionGate & { lastSequence: number | null } {
  return {
    lastSequence: initialLastSequence,
    getLastSequence() {
      return this.lastSequence;
    },
    decideReconnectStrategy({ lastSequence, serverSequence, serverStateHash, localStateHash }) {
      if (lastSequence === null) return 'full-sync';
      const gap = serverSequence - lastSequence;
      if (gap > 0 && gap <= 100) return 'delta-replay';
      if (gap > 100) return 'full-sync';
      if (gap === 0) return localStateHash !== serverStateHash ? 'full-sync' : 'none';
      return 'none';
    },
  };
}

type Harness = ReturnType<typeof createHarness>;

function createHarness(
  overrides: Partial<SessionConnectionDeps<TestClient, TestSessionData, TestQueueEvent, TestSessionEvent>> = {},
) {
  const timers = createTimerHarness();
  const clientsCreated: TestClient[] = [];
  const joinCalls: TestClient[] = [];
  const joinImpl = vi.fn(async (client: TestClient): Promise<TestSessionData | null> => ({
    queueState: { sequence: 10, stateHash: 'hash-10' },
    label: `join-${client.id}`,
  }));
  const replayImpl = vi.fn(
    async (
      _client: TestClient,
      _sinceSequence: number,
    ): Promise<SessionConnectionReplayResult<TestQueueEvent> | null> => null,
  );
  const leaveImpl = vi.fn(async () => {});
  const subscribeQueueImpl = vi.fn((_client: TestClient, _sink: SessionConnectionSink<TestQueueEvent>) => () => {});
  const subscribeSessionImpl = vi.fn((_client: TestClient, _sink: SessionConnectionSink<TestSessionEvent>) => () => {});

  const queueEvents: TestQueueEvent[] = [];
  const sessionEvents: TestSessionEvent[] = [];
  const sessionDataCalls: Array<{ client: TestClient; sessionData: TestSessionData }> = [];
  const fullSyncCalls: TestSessionData[] = [];
  const errors: unknown[] = [];
  const fatalReasons: string[] = [];
  const connectStarts: number[] = [];
  const recoveryEvents: Array<{ kind: string; error: unknown }> = [];

  let nextClientId = 1;
  let reconnectHandler: (() => void) | null = null;

  const gate = createGate(null);

  const deps: SessionConnectionDeps<TestClient, TestSessionData, TestQueueEvent, TestSessionEvent> = {
    sessionId: 'session-1',
    createClient: (onReconnect) => {
      reconnectHandler = onReconnect;
      const client = createTestClient(nextClientId++);
      clientsCreated.push(client);
      return client;
    },
    join: async (client) => {
      joinCalls.push(client);
      return joinImpl(client);
    },
    leave: leaveImpl,
    replayEvents: replayImpl,
    subscribeQueue: subscribeQueueImpl,
    subscribeSession: subscribeSessionImpl,
    gate,
    getLocalStateHash: () => 'local-hash',
    applyFullSync: (sessionData) => {
      fullSyncCalls.push(sessionData);
    },
    onConnectStart: () => {
      connectStarts.push(Date.now());
    },
    onSessionData: (client, sessionData) => {
      sessionDataCalls.push({ client, sessionData });
    },
    onQueueEvent: (event) => {
      queueEvents.push(event);
    },
    onSessionEvent: (event) => {
      sessionEvents.push(event);
    },
    onError: (error) => {
      errors.push(error);
    },
    onFatal: (reason) => {
      fatalReasons.push(reason);
    },
    onRecoveryEvent: (kind, error) => {
      recoveryEvents.push({ kind, error });
    },
    retryPolicy: {
      initialRetryDelayMs: 1000,
      maxRetryDelayMs: 30000,
      backoffMultiplier: 2,
      maxTransientRetries: 2,
    },
    scheduleTimer: timers.scheduleTimer,
    clearTimer: timers.clearTimer,
    ...overrides,
  };

  const controller = createSessionConnectionController(deps);

  return {
    controller,
    deps,
    timers,
    clientsCreated,
    joinCalls,
    joinImpl,
    replayImpl,
    leaveImpl,
    subscribeQueueImpl,
    subscribeSessionImpl,
    queueEvents,
    sessionEvents,
    sessionDataCalls,
    fullSyncCalls,
    errors,
    fatalReasons,
    connectStarts,
    recoveryEvents,
    gate,
    triggerReconnect: () => reconnectHandler?.(),
  };
}

/** Yield to the real event loop (a macrotask tick) so every pending
 *  microtask — including chains several `await`s deep, like
 *  `ensureJoined`'s getBoardPath -> execute -> join round trip — has
 *  drained. A fixed count of `Promise.resolve()` hops is fragile: the exact
 *  number of microtask turns a chain takes shifts with implementation
 *  details (e.g. how many `vi.fn()`/wrapper layers sit between the test and
 *  the actual work), so this flushes twice with a macrotask boundary in
 *  between rather than counting hops. */
async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createSessionConnectionController', () => {
  it('connects, joins, applies full sync, and subscribes on the happy path', async () => {
    const harness = createHarness();
    harness.controller.start();
    await flushMicrotasks();

    expect(harness.joinCalls).toHaveLength(1);
    expect(harness.sessionDataCalls).toHaveLength(1);
    expect(harness.fullSyncCalls).toHaveLength(1);
    expect(harness.subscribeQueueImpl).toHaveBeenCalledTimes(1);
    expect(harness.subscribeSessionImpl).toHaveBeenCalledTimes(1);
  });

  it('reconnect with a sequence gap replays the missing events via delta-replay', async () => {
    const harness = createHarness();
    harness.gate.lastSequence = 5;
    harness.joinImpl.mockResolvedValue({ queueState: { sequence: 8, stateHash: 'hash-8' }, label: 'joined' });
    const replayEvents: TestQueueEvent[] = [
      { __typename: 'QueueItemAdded', sequence: 6, stateHash: 'hash-6' },
      { __typename: 'QueueItemAdded', sequence: 7, stateHash: 'hash-7' },
      { __typename: 'QueueItemAdded', sequence: 8, stateHash: 'hash-8' },
    ];
    harness.replayImpl.mockResolvedValue({ events: replayEvents, currentSequence: 8 });

    harness.controller.start();
    await flushMicrotasks();
    harness.fullSyncCalls.length = 0; // clear the initial-connect full sync

    harness.triggerReconnect();
    await flushMicrotasks();

    expect(harness.replayImpl).toHaveBeenCalledWith(expect.anything(), 5);
    expect(harness.queueEvents).toEqual(replayEvents);
    // Delta-replay succeeded — no full-sync fallback.
    expect(harness.fullSyncCalls).toHaveLength(0);
  });

  it('falls back to full sync when the replay is incomplete (non-contiguous coverage)', async () => {
    const harness = createHarness();
    harness.gate.lastSequence = 5;
    harness.joinImpl.mockResolvedValue({ queueState: { sequence: 8, stateHash: 'hash-8' }, label: 'joined' });
    // Missing sequence 7 — non-contiguous.
    harness.replayImpl.mockResolvedValue({
      events: [
        { __typename: 'QueueItemAdded', sequence: 6, stateHash: 'hash-6' },
        { __typename: 'QueueItemAdded', sequence: 8, stateHash: 'hash-8' },
      ],
      currentSequence: 8,
    });

    harness.controller.start();
    await flushMicrotasks();
    harness.fullSyncCalls.length = 0;
    harness.queueEvents.length = 0;

    harness.triggerReconnect();
    await flushMicrotasks();

    // The incomplete replay's events are NOT applied individually...
    expect(harness.queueEvents).toHaveLength(0);
    // ...the controller falls back to a full sync instead.
    expect(harness.fullSyncCalls).toHaveLength(1);
    expect(harness.fullSyncCalls[0]?.queueState?.sequence).toBe(8);
    // The fallback is surfaced through the observability port.
    expect(harness.recoveryEvents).toHaveLength(1);
    expect(harness.recoveryEvents[0]?.kind).toBe('delta-sync-fallback');
  });

  it('falls back to full sync when replayEvents returns null', async () => {
    const harness = createHarness();
    harness.gate.lastSequence = 5;
    harness.joinImpl.mockResolvedValue({ queueState: { sequence: 8, stateHash: 'hash-8' }, label: 'joined' });
    harness.replayImpl.mockResolvedValue(null);

    harness.controller.start();
    await flushMicrotasks();
    harness.fullSyncCalls.length = 0;

    harness.triggerReconnect();
    await flushMicrotasks();

    expect(harness.fullSyncCalls).toHaveLength(1);
  });

  it('exhausting transient connect retries calls onFatal exactly once', async () => {
    const harness = createHarness({
      join: async () => null,
    });

    harness.controller.start();
    await flushMicrotasks();

    // maxTransientRetries = 2: first failure schedules retry #1, second
    // failure schedules retry #2, third failure exhausts and calls onFatal.
    expect(harness.fatalReasons).toEqual([]);
    expect(harness.timers.pendingCount).toBe(1);

    harness.timers.flushAll();
    await flushMicrotasks();
    expect(harness.fatalReasons).toEqual([]);
    expect(harness.timers.pendingCount).toBe(1);

    harness.timers.flushAll();
    await flushMicrotasks();

    expect(harness.fatalReasons).toEqual(['transient-retries-exhausted']);
    // No further retry scheduled after exhaustion.
    expect(harness.timers.pendingCount).toBe(0);

    // Further timer flushes (there are none) can't cause a second onFatal —
    // exhaustion fires exactly once.
    expect(harness.fatalReasons).toHaveLength(1);
  });

  it('exhausting subscription retries calls onFatal exactly once', async () => {
    // Every successful rejoin resets `subscriptionRetryCount` to 0 before
    // `startSubscriptions` re-attaches (see the previous test) — so with
    // `maxTransientRetries >= 1`, a subscription that keeps failing right
    // after each successful rejoin never actually exceeds the budget (it's
    // reset back to 0 every cycle before erroring again). `maxTransientRetries:
    // 0` isolates the exhaustion branch itself: strike 1 already exceeds a
    // zero-retry budget, exercising increment -> threshold-check -> reset ->
    // onFatal -> no further timer scheduled, exactly once.
    const sinkHolder: { current: SessionConnectionSink<TestQueueEvent> | null } = { current: null };
    const harness = createHarness({
      subscribeQueue: (_client, sink) => {
        sinkHolder.current = sink;
        return () => {};
      },
      retryPolicy: {
        initialRetryDelayMs: 100,
        maxRetryDelayMs: 1000,
        backoffMultiplier: 2,
        maxTransientRetries: 0,
      },
    });

    harness.controller.start();
    await flushMicrotasks();
    expect(sinkHolder.current).not.toBeNull();

    sinkHolder.current?.error(new Error('boom'));
    await flushMicrotasks();

    expect(harness.fatalReasons).toEqual(['subscription-retries-exhausted']);
    expect(harness.fatalReasons).toHaveLength(1);
    // No recovery timer scheduled after exhaustion — this specific
    // exhaustion event fired onFatal exactly once, not once-plus-a-pending-retry.
    expect(harness.timers.pendingCount).toBe(0);
  });

  it('stop() mid-join prevents any post-stop callbacks from firing', async () => {
    const joinGate = deferred<TestSessionData | null>();
    const harness = createHarness({
      join: async () => joinGate.promise,
    });

    harness.controller.start();
    await flushMicrotasks();

    // Join is in flight — stop the controller before it resolves.
    harness.controller.stop({ sendLeave: false });

    joinGate.resolve({ queueState: { sequence: 1, stateHash: 'h1' }, label: 'late-join' });
    await flushMicrotasks();

    expect(harness.sessionDataCalls).toHaveLength(0);
    expect(harness.fullSyncCalls).toHaveLength(0);
    expect(harness.subscribeQueueImpl).not.toHaveBeenCalled();
    expect(harness.subscribeSessionImpl).not.toHaveBeenCalled();
    expect(harness.fatalReasons).toHaveLength(0);
    // The client created for the in-flight attempt is disposed, not leaked.
    expect(harness.clientsCreated[0]?.disposed).toBe(true);
  });

  it('bumps the join epoch on reconnect so a stale join promise from the old socket is not reused', async () => {
    let callCount = 0;
    const firstJoin = deferred<TestSessionData | null>();
    const secondJoin = deferred<TestSessionData | null>();
    const harness = createHarness({
      join: async () => {
        callCount++;
        return callCount === 1 ? firstJoin.promise : secondJoin.promise;
      },
    });

    harness.controller.start();
    await flushMicrotasks();
    // Initial connect's join is in flight (unresolved).
    expect(callCount).toBe(1);

    // Simulate a reconnect before the initial join resolves — this bumps
    // the epoch and fires a second, independent join.
    harness.triggerReconnect();
    await flushMicrotasks();
    expect(callCount).toBe(2);

    // The NEW (post-bump) join resolves first with fresh data.
    secondJoin.resolve({ queueState: { sequence: 20, stateHash: 'hash-20' }, label: 'fresh' });
    await flushMicrotasks();

    expect(harness.sessionDataCalls.at(-1)?.sessionData.label).toBe('fresh');

    // The STALE (pre-bump) join now resolves late. Its result must not
    // clobber the fresh join's outcome.
    firstJoin.resolve({ queueState: { sequence: 1, stateHash: 'hash-1' }, label: 'stale' });
    await flushMicrotasks();

    expect(harness.sessionDataCalls.some((call) => call.sessionData.label === 'stale')).toBe(false);
  });

  it('resets the subscription retry counter after every successful rejoin, not just once', async () => {
    // Regression guard ported from `use-session-lifecycle.ts:511-519`'s
    // comment: a low-traffic session where every reconnect succeeds but no
    // event arrives before the next disconnect must NOT accumulate strikes
    // across cycles. maxTransientRetries: 1 makes this sharp — WITHOUT the
    // reset, two consecutive subscription errors (even with a successful
    // rejoin in between) would exceed the budget on the second error.
    const sinkHolder: { current: SessionConnectionSink<TestQueueEvent> | null } = { current: null };
    const harness = createHarness({
      subscribeQueue: (_client, sink) => {
        sinkHolder.current = sink;
        return () => {};
      },
      retryPolicy: {
        initialRetryDelayMs: 100,
        maxRetryDelayMs: 1000,
        backoffMultiplier: 2,
        maxTransientRetries: 1,
      },
    });

    harness.controller.start();
    await flushMicrotasks();
    const firstSink = sinkHolder.current;
    expect(firstSink).not.toBeNull();

    // First subscription error: counter -> 1/1, still under budget, recovery scheduled.
    firstSink?.error(new Error('flake 1'));
    expect(harness.timers.pendingCount).toBe(1);
    expect(harness.fatalReasons).toEqual([]);

    // Recovery fires handleReconnect -> successful rejoin -> resubscribe.
    harness.timers.flushAll();
    await flushMicrotasks();
    const secondSink = sinkHolder.current;
    expect(secondSink).not.toBeNull();
    expect(secondSink).not.toBe(firstSink);

    // Second subscription error on the NEW subscription: if the counter had
    // NOT reset, this would be strike 2/1 (exceeds budget) -> onFatal. With
    // the reset, it's strike 1/1 again -> still just a scheduled recovery.
    secondSink?.error(new Error('flake 2'));
    await flushMicrotasks();

    expect(harness.fatalReasons).toEqual([]);
    expect(harness.timers.pendingCount).toBe(1);
  });

  it('abandons a superseded initial join silently when the STALE join resolves first', async () => {
    // The reproduced regression: socket bounces mid-initial-join, the
    // reconnect bumps the epoch and fires join #2 — and then join #1
    // resolves FIRST (the normal ordering on flaky wifi, since graphql-ws
    // re-executes pending operations on the new socket). Pre-fix, connect()
    // read `lastJoinResult === null` (the stale epoch-gated write was
    // discarded), misclassified the SUCCESSFUL join as a no-payload
    // failure, burned a retry strike, surfaced an error, and disposed the
    // client the in-flight reconnect was still using — and the retry's
    // fresh client then hit the tracker cache so JOIN_SESSION never went
    // over its connection.
    let callCount = 0;
    const firstJoin = deferred<TestSessionData | null>();
    const secondJoin = deferred<TestSessionData | null>();
    const harness = createHarness({
      join: async () => {
        callCount++;
        return callCount === 1 ? firstJoin.promise : secondJoin.promise;
      },
    });

    harness.controller.start();
    await flushMicrotasks();
    expect(callCount).toBe(1);

    // Socket bounce mid-initial-join: reconnect bumps the epoch, fires join #2.
    harness.triggerReconnect();
    await flushMicrotasks();
    expect(callCount).toBe(2);

    // The STALE (pre-bump) join resolves FIRST — successfully.
    firstJoin.resolve({ queueState: { sequence: 5, stateHash: 'hash-5' }, label: 'stale' });
    await flushMicrotasks();

    // Abandoned silently: no error, no fatal, no retry timer scheduled, no
    // onSessionData from the stale flow — and critically the shared client
    // was NOT disposed out from under the in-flight reconnect.
    expect(harness.errors).toEqual([]);
    expect(harness.fatalReasons).toEqual([]);
    expect(harness.timers.pendingCount).toBe(0);
    expect(harness.sessionDataCalls).toHaveLength(0);
    expect(harness.clientsCreated[0]?.disposed).toBe(false);

    // The fresh join completes normally on the same (undisposed) client.
    secondJoin.resolve({ queueState: { sequence: 20, stateHash: 'hash-20' }, label: 'fresh' });
    await flushMicrotasks();
    expect(harness.sessionDataCalls).toHaveLength(1);
    expect(harness.sessionDataCalls[0]?.sessionData.label).toBe('fresh');
    expect(harness.sessionDataCalls[0]?.client).toBe(harness.clientsCreated[0]);
    expect(harness.errors).toEqual([]);
  });

  it('stop() mid-delta-replay suppresses every port callback after stop returns', async () => {
    // Contract hole the reviewer reproduced: a session-A replay resolving
    // after teardown would re-dispatch A's events after the hook reset the
    // gate — a cross-session leak on an A->B switch.
    const harness = createHarness();
    harness.gate.lastSequence = 5;
    harness.joinImpl.mockResolvedValue({ queueState: { sequence: 8, stateHash: 'hash-8' }, label: 'joined' });
    const replayGate = deferred<SessionConnectionReplayResult<TestQueueEvent> | null>();
    harness.replayImpl.mockImplementation(async () => replayGate.promise);

    harness.controller.start();
    await flushMicrotasks();
    harness.fullSyncCalls.length = 0;
    harness.queueEvents.length = 0;
    const sessionDataCallsBeforeStop = harness.sessionDataCalls.length;

    // Reconnect: join resolves, replay is now in flight (pending).
    harness.triggerReconnect();
    await flushMicrotasks();
    expect(harness.replayImpl).toHaveBeenCalledTimes(1);

    harness.controller.stop({ sendLeave: false });

    replayGate.resolve({
      events: [
        { __typename: 'QueueItemAdded', sequence: 6, stateHash: 'hash-6' },
        { __typename: 'QueueItemAdded', sequence: 7, stateHash: 'hash-7' },
        { __typename: 'QueueItemAdded', sequence: 8, stateHash: 'hash-8' },
      ],
      currentSequence: 8,
    });
    await flushMicrotasks();

    // Zero port callbacks after stop() returned.
    expect(harness.queueEvents).toEqual([]);
    expect(harness.fullSyncCalls).toEqual([]);
    expect(harness.sessionDataCalls).toHaveLength(sessionDataCallsBeforeStop);
    expect(harness.errors).toEqual([]);
    expect(harness.recoveryEvents).toEqual([]);
  });

  it('stop() mid-delta-replay on the failure path suppresses the full-sync fallback too', async () => {
    // Same teardown window, but the replay REJECTS after stop() — the
    // catch-side guard must suppress both the recovery event and the
    // post-teardown full sync.
    const harness = createHarness();
    harness.gate.lastSequence = 5;
    harness.joinImpl.mockResolvedValue({ queueState: { sequence: 8, stateHash: 'hash-8' }, label: 'joined' });
    const replayGate = deferred<SessionConnectionReplayResult<TestQueueEvent> | null>();
    harness.replayImpl.mockImplementation(async () => replayGate.promise);

    harness.controller.start();
    await flushMicrotasks();
    harness.fullSyncCalls.length = 0;
    harness.queueEvents.length = 0;
    const sessionDataCallsBeforeStop = harness.sessionDataCalls.length;

    harness.triggerReconnect();
    await flushMicrotasks();
    expect(harness.replayImpl).toHaveBeenCalledTimes(1);

    harness.controller.stop({ sendLeave: false });

    replayGate.reject(new Error('socket torn down'));
    await flushMicrotasks();

    expect(harness.queueEvents).toEqual([]);
    expect(harness.fullSyncCalls).toEqual([]);
    expect(harness.sessionDataCalls).toHaveLength(sessionDataCallsBeforeStop);
    expect(harness.errors).toEqual([]);
    expect(harness.recoveryEvents).toEqual([]);
  });

  it('createClient throwing is fatal: onError + onFatal(connect-failed), no retry', async () => {
    const clientCreationError = new Error('WebSocket constructor unavailable');
    const harness = createHarness({
      createClient: () => {
        throw clientCreationError;
      },
    });

    harness.controller.start();
    await flushMicrotasks();

    expect(harness.errors).toEqual([clientCreationError]);
    expect(harness.fatalReasons).toEqual(['connect-failed']);
    // Fatal, not transient: no backoff retry scheduled.
    expect(harness.timers.pendingCount).toBe(0);
    expect(harness.joinCalls).toHaveLength(0);
  });

  it('stop({ sendLeave: true }) sends LEAVE_SESSION before disposing the client', async () => {
    const harness = createHarness();

    harness.controller.start();
    await flushMicrotasks();
    const client = harness.clientsCreated[0];
    expect(client).toBeDefined();

    harness.controller.stop({ sendLeave: true });
    await flushMicrotasks();

    expect(harness.leaveImpl).toHaveBeenCalledTimes(1);
    expect(harness.leaveImpl).toHaveBeenCalledWith(client);
    expect(client?.disposed).toBe(true);
  });

  it('stop({ sendLeave: false }) disposes without sending LEAVE_SESSION', async () => {
    const harness = createHarness();

    harness.controller.start();
    await flushMicrotasks();

    harness.controller.stop({ sendLeave: false });
    await flushMicrotasks();

    expect(harness.leaveImpl).not.toHaveBeenCalled();
    expect(harness.clientsCreated[0]?.disposed).toBe(true);
  });

  it('triggerResync() forces a rejoin and re-delivers session data', async () => {
    const harness = createHarness();

    harness.controller.start();
    await flushMicrotasks();
    expect(harness.joinCalls).toHaveLength(1);
    expect(harness.sessionDataCalls).toHaveLength(1);

    // External resync (the hook wires this into useSessionSubscriptions'
    // triggerResync action) — must re-join rather than serve the cached
    // join, and must hand fresh session data back through the port.
    harness.controller.triggerResync();
    await flushMicrotasks();

    expect(harness.joinCalls).toHaveLength(2);
    expect(harness.sessionDataCalls).toHaveLength(2);
    expect(harness.errors).toEqual([]);
    expect(harness.fatalReasons).toEqual([]);
  });

  it('triggerResync() after a failed connect is a no-op (no disposed-client rejoin)', async () => {
    // After connect()'s failure path disposes its client, the controller
    // drops the reference — a triggerResync during the retry-backoff window
    // must not attempt a rejoin against the disposed client.
    let joinShouldFail = true;
    const harness = createHarness({
      join: async () => {
        if (joinShouldFail) return null;
        return { queueState: { sequence: 1, stateHash: 'h1' }, label: 'ok' };
      },
    });

    harness.controller.start();
    await flushMicrotasks();
    // First attempt failed; retry scheduled; client #1 disposed.
    expect(harness.clientsCreated[0]?.disposed).toBe(true);
    expect(harness.timers.pendingCount).toBe(1);

    const joinCallsAfterFailure = harness.joinCalls.length;
    harness.controller.triggerResync();
    await flushMicrotasks();
    // No rejoin attempted against the dead client.
    expect(harness.joinCalls).toHaveLength(joinCallsAfterFailure);

    // The scheduled retry still recovers normally with a fresh client.
    joinShouldFail = false;
    harness.timers.flushAll();
    await flushMicrotasks();
    expect(harness.sessionDataCalls).toHaveLength(1);
    expect(harness.sessionDataCalls[0]?.client).toBe(harness.clientsCreated[1]);
  });

  it('treats a rejoin without a queue snapshot as a failed rejoin (B3 guard)', async () => {
    // `Session.queueState` is schema-nullable (null on the non-member
    // preview / createSession HTTP paths); joinSession always returns a
    // snapshot, so a null on rejoin is a malformed response. Without a
    // sequence/hash there is nothing to reconcile against — the controller
    // must bail silently (no strategy consult, no sync, no onSessionData)
    // and surface only the observability event, exactly like the base
    // hook's `rejoinedQueueState` guard.
    const harness = createHarness();
    harness.controller.start();
    await flushMicrotasks();
    expect(harness.sessionDataCalls).toHaveLength(1);
    harness.fullSyncCalls.length = 0;

    harness.joinImpl.mockResolvedValue({ queueState: null, label: 'malformed' });
    harness.triggerReconnect();
    await flushMicrotasks();

    expect(harness.recoveryEvents).toEqual([{ kind: 'rejoin-missing-queue-state', error: null }]);
    // No sync applied, no session data delivered, nothing surfaced as an error.
    expect(harness.fullSyncCalls).toEqual([]);
    expect(harness.queueEvents).toEqual([]);
    expect(harness.sessionDataCalls).toHaveLength(1);
    expect(harness.errors).toEqual([]);
    expect(harness.fatalReasons).toEqual([]);
  });
});
