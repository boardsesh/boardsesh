import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ClimbQueueItemInput } from '@boardsesh/shared-schema';
import {
  ADD_QUEUE_ITEM,
  REMOVE_QUEUE_ITEM,
  REORDER_QUEUE_ITEM,
  SET_CURRENT_CLIMB,
  SET_QUEUE,
  SET_QUEUE_WITH_BASELINE,
  MIRROR_CURRENT_CLIMB,
  REPLACE_QUEUE_ITEM,
  CONFIRM_CLIMB_ON_WALL,
  REPORT_WALL_DISCONNECT,
  SET_SESSION_BOARD_SERIAL,
  SET_SESSION_BOARD_PATH,
} from '@boardsesh/graphql/operations/queue-session';

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));
vi.mock('@boardsesh/graphql-client', () => ({ execute: executeMock }));

import { createQueueMutations, type QueueMutationsDeps } from '../create-queue-mutations';

// Minimal item shape — the factory is generic over TItem and only forwards it
// through the injected mapper, so a stand-in is enough.
type TestItem = { uuid: string; climb: { uuid: string } };
const item = (uuid: string): TestItem => ({ uuid, climb: { uuid: `c-${uuid}` } });
const toQueueItemInput = (it: TestItem) => ({ uuid: it.uuid, climb: it.climb }) as unknown as ClimbQueueItemInput;

const client = {} as never; // execute is mocked, so the client value is opaque.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// Stands in for the client's local reducer queue. `getQueuePosition` is wired to
// a real findIndex over it, so an expected `position` comes from seeded data
// rather than a stub's canned return. Tests mutate it to model reorders, removes
// and wholesale server syncs mid-flight.
let localQueue: TestItem[] = [];

function make(overrides: Partial<QueueMutationsDeps<TestItem>> = {}) {
  return createQueueMutations<TestItem>({
    getClient: () => client,
    getSessionId: () => 'S',
    toQueueItemInput,
    getQueuePosition: (uuid) => localQueue.findIndex((queueItem) => queueItem.uuid === uuid),
    ...overrides,
  });
}

const queriesFor = (query: string) => executeMock.mock.calls.filter(([, op]) => op.query === query);

beforeEach(() => {
  executeMock.mockReset();
  executeMock.mockResolvedValue(undefined);
  localQueue = [];
});

describe('web mode (no ensureReady)', () => {
  it('issues ADD_QUEUE_ITEM with mapped input + position', async () => {
    await make().addQueueItem(item('a'), 2);
    expect(queriesFor(ADD_QUEUE_ITEM)).toHaveLength(1);
    expect(queriesFor(ADD_QUEUE_ITEM)[0][1].variables).toEqual({
      item: { uuid: 'a', climb: { uuid: 'c-a' } },
      position: 2,
    });
  });

  it('issues REMOVE_QUEUE_ITEM', async () => {
    await make().removeQueueItem('x');
    expect(queriesFor(REMOVE_QUEUE_ITEM)[0][1].variables).toEqual({ uuid: 'x' });
  });

  it('issues REORDER_QUEUE_ITEM with scalar indices', async () => {
    await make().reorderQueueItem('a', 0, 2);
    expect(queriesFor(REORDER_QUEUE_ITEM)[0][1].variables).toEqual({ uuid: 'a', oldIndex: 0, newIndex: 2 });
  });

  it('maps the queue and the optional current item for SET_QUEUE', async () => {
    await make().setQueue([item('a'), item('b')], item('c'));
    const vars = queriesFor(SET_QUEUE)[0][1].variables;
    expect(vars.queue).toEqual([
      { uuid: 'a', climb: { uuid: 'c-a' } },
      { uuid: 'b', climb: { uuid: 'c-b' } },
    ]);
    expect(vars.currentClimbQueueItem).toEqual({ uuid: 'c', climb: { uuid: 'c-c' } });
  });

  it('passes undefined currentClimbQueueItem to SET_QUEUE when omitted', async () => {
    await make().setQueue([item('a')]);
    expect(queriesFor(SET_QUEUE)[0][1].variables.currentClimbQueueItem).toBeUndefined();
  });

  it('issues MIRROR_CURRENT_CLIMB', async () => {
    await make().mirrorCurrentClimb(true);
    expect(queriesFor(MIRROR_CURRENT_CLIMB)[0][1].variables).toEqual({ mirrored: true });
  });

  it('issues REPLACE_QUEUE_ITEM with the mapped item', async () => {
    await make().replaceQueueItem('old', item('new'));
    expect(queriesFor(REPLACE_QUEUE_ITEM)[0][1].variables).toEqual({
      uuid: 'old',
      item: { uuid: 'new', climb: { uuid: 'c-new' } },
    });
  });

  it('throws when disconnected for core actions', async () => {
    const m = make({ getSessionId: () => null });
    await expect(m.addQueueItem(item('a'))).rejects.toThrow('Not connected to session');
    await expect(m.removeQueueItem('x')).rejects.toThrow('Not connected to session');
    await expect(m.setCurrentClimb(item('a'), true)).rejects.toThrow('Not connected to session');
    expect(executeMock).not.toHaveBeenCalled();
  });
});

describe('mobile mode (ensureReady)', () => {
  it('lazily creates a session for addQueueItem when none is active', async () => {
    const ensureReady = vi.fn(async (captured: string | null) => captured ?? 'new-session');
    await make({ getSessionId: () => null, ensureReady }).addQueueItem(item('a'));
    expect(ensureReady).toHaveBeenCalledWith(null);
    expect(queriesFor(ADD_QUEUE_ITEM)).toHaveLength(1);
  });

  it('no-ops (no create, no execute) for removeQueueItem when no session', async () => {
    const ensureReady = vi.fn(async (captured: string | null) => captured);
    await make({ getSessionId: () => null, ensureReady }).removeQueueItem('x');
    expect(ensureReady).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('no-ops (no create, no execute) for reorderQueueItem when no session', async () => {
    const ensureReady = vi.fn(async (captured: string | null) => captured);
    await make({ getSessionId: () => null, ensureReady }).reorderQueueItem('a', 0, 1);
    expect(ensureReady).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('issues REORDER_QUEUE_ITEM after ensureReady resolves an existing session', async () => {
    const ensureReady = vi.fn(async (captured: string | null) => captured);
    await make({ ensureReady }).reorderQueueItem('a', 2, 0);
    expect(ensureReady).toHaveBeenCalledWith('S');
    expect(queriesFor(REORDER_QUEUE_ITEM)[0][1].variables).toEqual({ uuid: 'a', oldIndex: 2, newIndex: 0 });
  });

  it('no-ops instead of throwing when ensureReady returns null', async () => {
    const ensureReady = vi.fn(async () => null);
    await make({ ensureReady }).addQueueItem(item('a'));
    expect(executeMock).not.toHaveBeenCalled();
  });

  // clearQueue (mobile provider) maps each item through removeQueueItem and
  // toasts only if Promise.allSettled reports a rejection. With no session every
  // remove must resolve as a no-op so the clear stays silent — this guards that
  // contract at the layer it depends on.
  it('removeQueueItem resolves (never rejects) as a no-op with no session, so a batch clear stays silent', async () => {
    const ensureReady = vi.fn(async (captured: string | null) => captured);
    const m = make({ getSessionId: () => null, ensureReady });
    const results = await Promise.allSettled(['a', 'b', 'c'].map((uuid) => m.removeQueueItem(uuid)));
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    expect(ensureReady).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });
});

describe('party / best-effort actions', () => {
  it('reportWallDisconnect no-ops when there is no session', async () => {
    await make({ getSessionId: () => null }).reportWallDisconnect();
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('reportWallDisconnect issues REPORT_WALL_DISCONNECT with a session', async () => {
    await make().reportWallDisconnect();
    expect(queriesFor(REPORT_WALL_DISCONNECT)[0][1].variables).toEqual({});
  });

  it('reportWallDisconnect swallows transport errors via onBestEffortError', async () => {
    executeMock.mockRejectedValueOnce(new Error('socket down'));
    const onBestEffortError = vi.fn();
    await expect(make({ onBestEffortError }).reportWallDisconnect()).resolves.toBeUndefined();
    expect(onBestEffortError).toHaveBeenCalledWith('reportWallDisconnect', expect.any(Error));
  });

  it('confirmClimbOnWall swallows transport errors via onBestEffortError', async () => {
    executeMock.mockRejectedValueOnce(new Error('socket down'));
    const onBestEffortError = vi.fn();
    await expect(make({ onBestEffortError }).confirmClimbOnWall('climb-1')).resolves.toBeUndefined();
    expect(executeMock).toHaveBeenCalledWith(client, {
      query: CONFIRM_CLIMB_ON_WALL,
      variables: { climbUuid: 'climb-1' },
    });
    expect(onBestEffortError).toHaveBeenCalledWith('confirmClimbOnWall', expect.any(Error));
  });

  it('setSessionBoardSerial swallows transport errors via onBestEffortError', async () => {
    executeMock.mockRejectedValueOnce(new Error('socket down'));
    const onBestEffortError = vi.fn();
    await expect(make({ onBestEffortError }).setSessionBoardSerial('ble-123')).resolves.toBeUndefined();
    expect(queriesFor(SET_SESSION_BOARD_SERIAL)[0][1].variables).toEqual({ serial: 'ble-123' });
    expect(onBestEffortError).toHaveBeenCalledWith('setSessionBoardSerial', expect.any(Error));
  });

  it('setSessionBoardPath swallows transport errors via onBestEffortError', async () => {
    executeMock.mockRejectedValueOnce(new Error('socket down'));
    const onBestEffortError = vi.fn();
    await expect(make({ onBestEffortError }).setSessionBoardPath('/kilter/A/B/C/40')).resolves.toBeUndefined();
    expect(queriesFor(SET_SESSION_BOARD_PATH)[0][1].variables).toEqual({ boardPath: '/kilter/A/B/C/40' });
    expect(onBestEffortError).toHaveBeenCalledWith('setSessionBoardPath', expect.any(Error));
  });
});

describe('setCurrentClimb coalescer', () => {
  it('fires ADD_QUEUE_ITEM for a superseded shouldAddToQueue request against its captured session', async () => {
    let firstResolve: (() => void) | undefined;
    let setCurrentCalls = 0;
    executeMock.mockImplementation((_c, op) => {
      if (op.query === SET_CURRENT_CLIMB) {
        setCurrentCalls += 1;
        if (setCurrentCalls === 1)
          return new Promise<void>((resolve) => {
            firstResolve = () => resolve();
          });
        return Promise.resolve();
      }
      return Promise.resolve();
    });

    const m = make();
    const pA = m.setCurrentClimb(item('A'), true); // SET_CURRENT #1 — stays in flight
    const pB = m.setCurrentClimb(item('B'), true); // pending = B
    const pC = m.setCurrentClimb(item('C'), true); // supersedes B -> ADD(B)
    await flush();

    const addedItems = queriesFor(ADD_QUEUE_ITEM).map(([, op]) => op.variables.item);
    expect(addedItems).toContainEqual({ uuid: 'B', climb: { uuid: 'c-B' } });

    firstResolve?.();
    await Promise.all([pA, pB, pC]);

    // After the in-flight call resolves, the latest pending (C) drains.
    const setCurrentItems = queriesFor(SET_CURRENT_CLIMB).map(([, op]) => op.variables.item);
    expect(setCurrentItems).toContainEqual({ uuid: 'C', climb: { uuid: 'c-C' } });
  });

  it('drops the superseded queue-add when the captured session has flipped', async () => {
    let sid = 'S';
    let firstResolve: (() => void) | undefined;
    let setCurrentCalls = 0;
    executeMock.mockImplementation((_c, op) => {
      if (op.query === SET_CURRENT_CLIMB) {
        setCurrentCalls += 1;
        if (setCurrentCalls === 1)
          return new Promise<void>((resolve) => {
            firstResolve = () => resolve();
          });
        return Promise.resolve();
      }
      return Promise.resolve();
    });

    const m = make({ getSessionId: () => sid });
    const pA = m.setCurrentClimb(item('A'), true); // in-flight, captured 'S'
    const pB = m.setCurrentClimb(item('B'), true); // pending, captured 'S'
    sid = 'other'; // session flips before B is superseded
    const pC = m.setCurrentClimb(item('C'), true); // supersedes B; B's captured 'S' != live 'other' -> no ADD
    await flush();

    expect(queriesFor(ADD_QUEUE_ITEM)).toHaveLength(0);

    firstResolve?.();
    await Promise.all([pA, pB, pC]);
  });

  it('bails (no SET_CURRENT_CLIMB) when the captured session flips during resolution', async () => {
    let sid: string | null = 'S';
    const ensureReady = vi.fn(async (captured: string | null) => {
      sid = 'other'; // session flips while we were resolving
      return captured;
    });
    await make({ getSessionId: () => sid, ensureReady }).setCurrentClimb(item('A'), true);
    expect(queriesFor(SET_CURRENT_CLIMB)).toHaveLength(0);
  });

  it('drops the superseded queue-add when ensureReady returns null (session ended before drain)', async () => {
    let firstResolve: (() => void) | undefined;
    let setCurrentCalls = 0;
    executeMock.mockImplementation((_c, op) => {
      if (op.query === SET_CURRENT_CLIMB) {
        setCurrentCalls += 1;
        if (setCurrentCalls === 1)
          return new Promise<void>((resolve) => {
            firstResolve = () => resolve();
          });
        return Promise.resolve();
      }
      return Promise.resolve();
    });
    // First resolution (A's sendArgs) succeeds so A stays in flight; the
    // superseded ADD for B then sees a null (session ended) and must bail.
    const ensureReady = vi.fn(async (_captured: string | null): Promise<string | null> => null);
    ensureReady.mockResolvedValueOnce('S');

    const m = make({ getSessionId: () => 'S', ensureReady });
    const pA = m.setCurrentClimb(item('A'), true); // in-flight (ensureReady -> 'S')
    const pB = m.setCurrentClimb(item('B'), true); // pending, captured 'S'
    const pC = m.setCurrentClimb(item('C'), true); // supersedes B -> ensureReady -> null -> no ADD
    await flush();

    expect(queriesFor(ADD_QUEUE_ITEM)).toHaveLength(0);

    firstResolve?.();
    await Promise.all([pA, pB, pC]);
  });

  it('carries the item local position on the superseded queue-add (#3936)', async () => {
    // The picker's own queue: the superseded item B sits at index 2, because the
    // reducer inserted it right after the current climb.
    localQueue = [item('X'), item('cur'), item('B')];
    let firstResolve: (() => void) | undefined;
    let setCurrentCalls = 0;
    executeMock.mockImplementation((_c, op) => {
      if (op.query !== SET_CURRENT_CLIMB) return Promise.resolve();
      setCurrentCalls += 1;
      if (setCurrentCalls === 1)
        return new Promise<void>((resolve) => {
          firstResolve = () => resolve();
        });
      return Promise.resolve();
    });

    const m = make();
    const pA = m.setCurrentClimb(item('A'), true);
    const pB = m.setCurrentClimb(item('B'), true);
    const pC = m.setCurrentClimb(item('C'), true); // supersedes B -> ADD(B)
    await flush();

    // Exact variables: `position` is optional on this same object, so a partial
    // match would stay green if it were dropped again — which IS the bug.
    expect(queriesFor(ADD_QUEUE_ITEM)).toHaveLength(1);
    expect(queriesFor(ADD_QUEUE_ITEM)[0][1].variables).toEqual({
      item: { uuid: 'B', climb: { uuid: 'c-B' } },
      position: 2,
    });

    firstResolve?.();
    await Promise.all([pA, pB, pC]);
  });

  it('fires a positioned ADD_QUEUE_ITEM when the DRAINED activation is throttled away (#3936)', async () => {
    localQueue = [item('X'), item('cur'), item('A'), item('B')];
    let firstResolve: (() => void) | undefined;
    let setCurrentCalls = 0;
    executeMock.mockImplementation((_c, op) => {
      if (op.query !== SET_CURRENT_CLIMB) return Promise.resolve();
      setCurrentCalls += 1;
      if (setCurrentCalls === 1)
        return new Promise<void>((resolve) => {
          firstResolve = () => resolve();
        });
      return Promise.reject(new Error('RATE_LIMITED'));
    });
    const onBestEffortError = vi.fn();

    const m = make({ onBestEffortError });
    const pA = m.setCurrentClimb(item('A'), true);
    const pB = m.setCurrentClimb(item('B'), true); // pending; drains, then throttled
    // pB parked as pending synchronously, so releasing the head drains it now.
    firstResolve?.();
    await Promise.all([pA, pB]);
    await flush();

    expect(queriesFor(ADD_QUEUE_ITEM)).toHaveLength(1);
    expect(queriesFor(ADD_QUEUE_ITEM)[0][1].variables).toEqual({
      item: { uuid: 'B', climb: { uuid: 'c-B' } },
      position: 3,
    });
    // The pointer loss is still reported (dev-log only) — the recovery does not
    // replace the report.
    expect(onBestEffortError).toHaveBeenCalledWith('setCurrentClimb', expect.any(Error));
  });

  // The interleaving that makes a bare "-1 -> skip" guard swallow the whole
  // fix: the burst's HEAD activation is itself an add, so the server answers it
  // with a FullSync, which INITIAL_QUEUE_DATA applies by REPLACING the local
  // queue — wiping the pending item's not-yet-sent optimistic slot seconds
  // before the rate-limited drain rejects.
  it('still sends the deferred add when a wholesale server sync wiped the local slot', async () => {
    localQueue = [item('X'), item('cur'), item('A'), item('B')];
    let firstResolve: (() => void) | undefined;
    let setCurrentCalls = 0;
    executeMock.mockImplementation((_c, op) => {
      if (op.query !== SET_CURRENT_CLIMB) return Promise.resolve();
      setCurrentCalls += 1;
      if (setCurrentCalls === 1)
        return new Promise<void>((resolve) => {
          firstResolve = () => resolve();
        });
      // The drained send sits in rate-limit back-off. While it does, the
      // FullSync triggered by A's own add lands: the server snapshot has no B.
      return new Promise<void>((_resolve, reject) =>
        setTimeout(() => {
          localQueue = [item('X'), item('cur'), item('A')];
          reject(new Error('RATE_LIMITED'));
        }, 0),
      );
    });

    const m = make({ onBestEffortError: () => {} });
    const pA = m.setCurrentClimb(item('A'), true);
    const pB = m.setCurrentClimb(item('B'), true);
    // pB parked as pending synchronously, so releasing the head drains it now.
    firstResolve?.();
    await Promise.all([pA, pB]);
    await flush();

    // Dropping this add is the bug: the crew never gets the climb and the
    // picker's pick vanishes. No position to honour, so the server appends.
    expect(queriesFor(ADD_QUEUE_ITEM)).toHaveLength(1);
    expect(queriesFor(ADD_QUEUE_ITEM)[0][1].variables).toEqual({ item: { uuid: 'B', climb: { uuid: 'c-B' } } });
    expect(queriesFor(ADD_QUEUE_ITEM)[0][1].variables.position).toBeUndefined();
  });

  it('skips the deferred add when the climber REMOVED the item while it was backing off', async () => {
    localQueue = [item('X'), item('cur'), item('A'), item('B')];
    let firstResolve: (() => void) | undefined;
    let setCurrentCalls = 0;
    let removeDuringBackoff: (() => Promise<void>) | undefined;
    executeMock.mockImplementation((_c, op) => {
      if (op.query !== SET_CURRENT_CLIMB) return Promise.resolve();
      setCurrentCalls += 1;
      if (setCurrentCalls === 1)
        return new Promise<void>((resolve) => {
          firstResolve = () => resolve();
        });
      return new Promise<void>((_resolve, reject) =>
        setTimeout(() => {
          localQueue = localQueue.filter((queueItem) => queueItem.uuid !== 'B');
          void removeDuringBackoff?.();
          reject(new Error('RATE_LIMITED'));
        }, 0),
      );
    });

    const m = make({ onBestEffortError: () => {} });
    removeDuringBackoff = () => m.removeQueueItem('B');
    const pA = m.setCurrentClimb(item('A'), true);
    const pB = m.setCurrentClimb(item('B'), true);
    // pB parked as pending synchronously, so releasing the head drains it now.
    firstResolve?.();
    await Promise.all([pA, pB]);
    await flush();

    // The climber dropped it. Re-adding would put a climb nobody asked for back
    // on the whole crew's queue.
    expect(queriesFor(ADD_QUEUE_ITEM)).toHaveLength(0);
    expect(queriesFor(REMOVE_QUEUE_ITEM)).toHaveLength(1);
  });

  // Web's Clear button (`setQueue([])`) and mobile's playlist "replace my
  // queue" (`setQueue([item], item)`) are climber-initiated removals that never
  // call removeQueueItem — so the ledger has to learn about them from setQueue.
  it('skips the deferred add when the climber REPLACED the whole queue while it was backing off', async () => {
    localQueue = [item('X'), item('cur'), item('A'), item('B')];
    let firstResolve: (() => void) | undefined;
    let setCurrentCalls = 0;
    let clearDuringBackoff: (() => Promise<void>) | undefined;
    executeMock.mockImplementation((_c, op) => {
      if (op.query !== SET_CURRENT_CLIMB) return Promise.resolve();
      setCurrentCalls += 1;
      if (setCurrentCalls === 1)
        return new Promise<void>((resolve) => {
          firstResolve = () => resolve();
        });
      return new Promise<void>((_resolve, reject) =>
        setTimeout(() => {
          localQueue = [];
          void clearDuringBackoff?.();
          reject(new Error('RATE_LIMITED'));
        }, 0),
      );
    });

    const m = make({ onBestEffortError: () => {} });
    clearDuringBackoff = () => m.setQueue([]);
    const pA = m.setCurrentClimb(item('A'), true);
    const pB = m.setCurrentClimb(item('B'), true);
    // pB parked as pending synchronously, so releasing the head drains it now.
    firstResolve?.();
    await Promise.all([pA, pB]);
    await flush();

    expect(queriesFor(ADD_QUEUE_ITEM)).toHaveLength(0);
    expect(queriesFor(SET_QUEUE)).toHaveLength(1);
  });

  // The ordering guard on the replace diff: only activations enqueued BEFORE
  // the replace can have been discarded by it. A climb picked afterwards and
  // then wiped by a server sync must still reach the crew.
  it('still sends the deferred add when the wholesale replace happened BEFORE the activation', async () => {
    const m = make({ onBestEffortError: () => {} });
    localQueue = [];
    await m.setQueue([]);

    localQueue = [item('cur'), item('A'), item('B')];
    let firstResolve: (() => void) | undefined;
    let setCurrentCalls = 0;
    executeMock.mockImplementation((_c, op) => {
      if (op.query !== SET_CURRENT_CLIMB) return Promise.resolve();
      setCurrentCalls += 1;
      if (setCurrentCalls === 1)
        return new Promise<void>((resolve) => {
          firstResolve = () => resolve();
        });
      return new Promise<void>((_resolve, reject) =>
        setTimeout(() => {
          localQueue = [item('cur'), item('A')];
          reject(new Error('RATE_LIMITED'));
        }, 0),
      );
    });

    const pA = m.setCurrentClimb(item('A'), true);
    const pB = m.setCurrentClimb(item('B'), true);
    firstResolve?.();
    await Promise.all([pA, pB]);
    await flush();

    expect(queriesFor(ADD_QUEUE_ITEM)).toHaveLength(1);
    expect(queriesFor(ADD_QUEUE_ITEM)[0][1].variables).toEqual({ item: { uuid: 'B', climb: { uuid: 'c-B' } } });
  });

  // mobile's clearQueue fires one removeQueueItem per queued item in a single
  // burst. A ring buffer smaller than the queue evicts the earliest entries of
  // its own clear, and that climb reappears on the crew's just-emptied queue.
  it('suppresses the FIRST item of a whole-queue clear far bigger than a 50-entry ledger', async () => {
    const bulk = Array.from({ length: 60 }, (_, index) => item(`q${index}`));
    localQueue = [item('cur'), ...bulk];
    let firstResolve: (() => void) | undefined;
    let setCurrentCalls = 0;
    let clearDuringBackoff: (() => Promise<unknown>) | undefined;
    executeMock.mockImplementation((_c, op) => {
      if (op.query !== SET_CURRENT_CLIMB) return Promise.resolve();
      setCurrentCalls += 1;
      if (setCurrentCalls === 1)
        return new Promise<void>((resolve) => {
          firstResolve = () => resolve();
        });
      return new Promise<void>((_resolve, reject) =>
        setTimeout(() => {
          localQueue = [];
          void clearDuringBackoff?.();
          reject(new Error('RATE_LIMITED'));
        }, 0),
      );
    });

    const m = make({ onBestEffortError: () => {} });
    // Oldest-first, exactly like the mobile provider's clearQueue.
    clearDuringBackoff = () => Promise.allSettled(bulk.map((queueItem) => m.removeQueueItem(queueItem.uuid)));
    const pA = m.setCurrentClimb(item('A'), true);
    // q0 is the first uuid the clear records — the one a 50-entry ring drops.
    const pQ0 = m.setCurrentClimb(bulk[0], true);
    firstResolve?.();
    await Promise.all([pA, pQ0]);
    await flush();

    expect(queriesFor(REMOVE_QUEUE_ITEM)).toHaveLength(60);
    expect(queriesFor(ADD_QUEUE_ITEM)).toHaveLength(0);
  });

  it('reads the position at SEND time, not at enqueue time', async () => {
    // B starts at index 0 and is reordered to index 2 while the throttled
    // SET_CURRENT_CLIMB backs off. A captured-at-enqueue index would misplace it
    // for the whole crew.
    localQueue = [item('B'), item('X')];
    let firstResolve: (() => void) | undefined;
    let setCurrentCalls = 0;
    executeMock.mockImplementation((_c, op) => {
      if (op.query !== SET_CURRENT_CLIMB) return Promise.resolve();
      setCurrentCalls += 1;
      if (setCurrentCalls === 1)
        return new Promise<void>((resolve) => {
          firstResolve = () => resolve();
        });
      return new Promise<void>((_resolve, reject) =>
        setTimeout(() => {
          localQueue = [item('X'), item('cur'), item('B')];
          reject(new Error('RATE_LIMITED'));
        }, 0),
      );
    });

    const m = make({ onBestEffortError: () => {} });
    const pA = m.setCurrentClimb(item('A'), true);
    const pB = m.setCurrentClimb(item('B'), true);
    // pB parked as pending synchronously, so releasing the head drains it now.
    firstResolve?.();
    await Promise.all([pA, pB]);
    await flush();

    expect(queriesFor(ADD_QUEUE_ITEM)[0][1].variables).toEqual({
      item: { uuid: 'B', climb: { uuid: 'c-B' } },
      position: 2,
    });
  });

  it('lazily creates a session from null on setCurrentClimb (mobile) and dispatches it', async () => {
    const ensureReady = vi.fn(async (captured: string | null) => captured ?? 'new-session');
    await make({ getSessionId: () => null, ensureReady }).setCurrentClimb(item('a'), true);
    expect(ensureReady).toHaveBeenCalledWith(null);
    expect(queriesFor(SET_CURRENT_CLIMB)[0][1].variables).toEqual({
      item: { uuid: 'a', climb: { uuid: 'c-a' } },
      shouldAddToQueue: true,
      correlationId: undefined,
    });
  });
});

// A wholesale replace can silently overwrite a climb a party member added while
// the payload was being composed (#3933). Callers that know the last server
// sequence they applied send it so the backend can merge that add back in. Web
// supplies no getter, so its document must stay byte-identical — an unknown
// argument is a document-level GraphQL validation error, which would hard-fail
// every setQueue against a backend that hasn't deployed the argument yet.
describe('setQueue baseline sequence (#3933)', () => {
  it('sends the legacy document when no baseline getter is injected (web)', async () => {
    await make().setQueue([item('a')]);
    expect(queriesFor(SET_QUEUE)).toHaveLength(1);
    expect(queriesFor(SET_QUEUE_WITH_BASELINE)).toHaveLength(0);
    expect(queriesFor(SET_QUEUE)[0][1].variables).not.toHaveProperty('baselineSequence');
  });

  it('sends the legacy document when the getter has no baseline yet', async () => {
    await make({ getBaselineSequence: () => null }).setQueue([item('a')]);
    expect(queriesFor(SET_QUEUE)).toHaveLength(1);
    expect(queriesFor(SET_QUEUE_WITH_BASELINE)).toHaveLength(0);
  });

  it('sends the baseline document with the applied sequence when one is available', async () => {
    await make({ getBaselineSequence: () => 42 }).setQueue([item('a')], item('a'));
    expect(queriesFor(SET_QUEUE)).toHaveLength(0);
    expect(queriesFor(SET_QUEUE_WITH_BASELINE)[0][1].variables).toEqual({
      queue: [{ uuid: 'a', climb: { uuid: 'c-a' } }],
      currentClimbQueueItem: { uuid: 'a', climb: { uuid: 'c-a' } },
      baselineSequence: 42,
    });
  });

  it('sends baseline 0 rather than dropping to the legacy document', async () => {
    // 0 is a real applied sequence, not "no baseline" — a `?? null` on the
    // wrong side of the falsy check would silently disable the merge for a
    // client that has applied exactly the seed event.
    await make({ getBaselineSequence: () => 0 }).setQueue([item('a')]);
    expect(queriesFor(SET_QUEUE_WITH_BASELINE)[0][1].variables.baselineSequence).toBe(0);
  });

  it('reads the baseline at send time, not at factory construction', async () => {
    let applied = 1;
    const mutations = make({ getBaselineSequence: () => applied });
    applied = 9;
    await mutations.setQueue([item('a')]);
    expect(queriesFor(SET_QUEUE_WITH_BASELINE)[0][1].variables.baselineSequence).toBe(9);
  });

  it('retries on the legacy document when the backend does not know the argument yet', async () => {
    // Rolling deploy / web preview pointed at prod / a mobile preview channel
    // running this branch — the old backend rejects the whole document at
    // validation time. Nobody's Clear button may hard-fail on deploy skew.
    executeMock.mockImplementation(async (_client: unknown, op: { query: string }) => {
      if (op.query === SET_QUEUE_WITH_BASELINE) {
        throw new Error('Unknown argument "baselineSequence" on field "Mutation.setQueue".');
      }
      return undefined;
    });

    await make({ getBaselineSequence: () => 42 }).setQueue([item('a')]);

    expect(queriesFor(SET_QUEUE_WITH_BASELINE)).toHaveLength(1);
    expect(queriesFor(SET_QUEUE)).toHaveLength(1);
    expect(queriesFor(SET_QUEUE)[0][1].variables).not.toHaveProperty('baselineSequence');
  });

  it('propagates a real server failure instead of silently retrying', async () => {
    executeMock.mockRejectedValue(new Error('Rate limit exceeded. Try again in 5 seconds.'));

    await expect(make({ getBaselineSequence: () => 42 }).setQueue([item('a')])).rejects.toThrow(/Rate limit/);
    expect(queriesFor(SET_QUEUE)).toHaveLength(0);
  });
});
