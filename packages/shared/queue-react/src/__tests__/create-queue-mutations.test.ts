import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ClimbQueueItemInput } from '@boardsesh/shared-schema';
import {
  ADD_QUEUE_ITEM,
  REMOVE_QUEUE_ITEM,
  REORDER_QUEUE_ITEM,
  SET_CURRENT_CLIMB,
  SET_QUEUE,
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

function make(overrides: Partial<QueueMutationsDeps<TestItem>> = {}) {
  return createQueueMutations<TestItem>({
    getClient: () => client,
    getSessionId: () => 'S',
    toQueueItemInput,
    ...overrides,
  });
}

const queriesFor = (query: string) => executeMock.mock.calls.filter(([, op]) => op.query === query);

beforeEach(() => {
  executeMock.mockReset();
  executeMock.mockResolvedValue(undefined);
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
